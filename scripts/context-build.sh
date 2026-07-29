#!/usr/bin/env bash
# Build a repository's knowledge wiki and watch the pages arrive.
#
# A derivation writes one Markdown page at a time into a sandbox and can run for
# up to two hours, so the useful thing is not the final answer but the pages
# landing one by one. This starts a build and follows it, printing each page as
# it appears and the reason for anything the citation rules withheld at the end.
#
# Usage:
#   scripts/context-build.sh <repository> [options]
#
#   scripts/context-build.sh omxyz/jina
#   scripts/context-build.sh omxyz/jina --budget 7200 --detail thorough
#   scripts/context-build.sh omxyz/jina --watch cb_1234...     # follow an existing build
#
# Options:
#   --ref <name>        Branch to build. Default: the repository's default branch.
#   --budget <seconds>  Wall clock the derivation may use, 300..7200. Default 5400 (90m).
#   --detail <level>    concise | standard | thorough. Default: the deployment's own.
#   --watch <buildId>   Do not start anything; follow a build that is already running.
#   --page <path>       Print one page's text as it stands right now, then exit.
#
# Requires: gcloud (logged in, with access to the jina-v2 project), curl, python3.
set -euo pipefail

API="${JINA_API_URL:-https://jina-api-m56inn6iva-uc.a.run.app}"
TENANT="${JINA_TENANT_ID:-eff0efc9-b103-494a-b7a3-1ae7f95c2d26}"
POLL_SECONDS="${POLL_SECONDS:-10}"

repository=""
ref=""
budget=5400
detail=""
watch_build=""
page_path=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) ref="${2:-}"; shift 2 ;;
    --budget) budget="${2:-}"; shift 2 ;;
    --detail) detail="${2:-}"; shift 2 ;;
    --watch) watch_build="${2:-}"; shift 2 ;;
    --page) page_path="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) repository="$1"; shift ;;
  esac
done

if [[ -z "$repository" && -z "$watch_build" ]]; then
  echo "usage: scripts/context-build.sh <repository> [--ref main] [--budget 5400] [--detail thorough]" >&2
  echo "       scripts/context-build.sh --watch <buildId>" >&2
  exit 2
fi

for tool in curl python3; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }
done

# A local stack hands its token over in the environment; production keeps it in
# Secret Manager, where an expired gcloud login shows up here rather than as a
# puzzling 401 later.
TOKEN="${JINA_INTERNAL_TOKEN:-}"
if [[ -z "$TOKEN" ]]; then
  TOKEN="$(gcloud secrets versions access latest --secret=jina-internal-api-token 2>/dev/null || true)"
fi
if [[ -z "$TOKEN" ]]; then
  echo "No API token. For production run 'gcloud auth login'; for a local stack" >&2
  echo "run scripts/dev-up.sh and 'source /tmp/jina-dev.env'." >&2
  exit 1
fi

auth=(-H "authorization: Bearer $TOKEN"
      -H "x-jina-tenant-id: $TENANT"
      -H "x-jina-principal-id: tenant:$TENANT")

api_get() { curl -sS "${auth[@]}" "$API$1"; }

if [[ -n "$page_path" ]]; then
  if [[ -z "$watch_build" ]]; then echo "--page needs --watch <buildId>" >&2; exit 2; fi
  api_get "/context/builds/$watch_build/page?path=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$page_path")" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["page"]["bodyMarkdown"])'
  exit 0
fi

build_id="$watch_build"
if [[ -z "$build_id" ]]; then
  body="$(python3 - "$repository" "$ref" "$budget" "$detail" <<'PY'
import json, sys
repository, ref, budget, detail = sys.argv[1:5]
request = {"repository": repository, "derivationBudgetSeconds": int(budget)}
if ref:
    request["ref"] = ref
if detail:
    request["derivationDetail"] = detail
print(json.dumps(request))
PY
)"
  echo "Starting a build of $repository (budget ${budget}s${detail:+, $detail})…"
  response="$(curl -sS "${auth[@]}" -H 'content-type: application/json' -d "$body" "$API/context/build")"
  build_id="$(python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("build",{}).get("id",""))
except Exception: print("")' <<<"$response")"
  if [[ -z "$build_id" ]]; then
    echo "Could not start the build:" >&2
    echo "$response" | head -c 500 >&2; echo >&2
    exit 1
  fi
fi

echo "Build $build_id — following. Ctrl-C stops watching; the build keeps running."
echo

# Only prints when something changes, so a long quiet stretch stays quiet rather
# than scrolling the same list past you every few seconds.
python3 - "$API" "$TOKEN" "$TENANT" "$build_id" "$POLL_SECONDS" <<'PY'
import json, sys, time, urllib.error, urllib.request

api, token, tenant, build_id, poll = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5])
headers = {
    "authorization": f"Bearer {token}",
    "x-jina-tenant-id": tenant,
    "x-jina-principal-id": f"tenant:{tenant}",
}

def get(path):
    request = urllib.request.Request(api + path, headers=headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)

seen, last_stages, started = {}, None, time.time()
stage_started = {}


def elapsed(since):
    seconds = int(time.time() - since)
    return f"{seconds // 60}m{seconds % 60:02d}s"

while True:
    try:
        progress = get(f"/context/builds/{build_id}/progress")
    except (urllib.error.URLError, TimeoutError) as error:
        # A failed poll says nothing about the build; the next one is seconds away.
        print(f"  (poll failed: {error})", flush=True)
        time.sleep(poll)
        continue

    # ingest -> derive -> index: derivation reads the manifest ingestion wrote,
    # and indexing exists to make the pages derivation produced fast to query.
    labels = {"ingest-evidence": "1 ingest", "derive-knowledge": "2 derive", "index-context": "3 index"}
    order = {"ingest-evidence": 0, "derive-knowledge": 1, "index-context": 2}
    ordered = sorted(progress.get("stages", []), key=lambda s: order.get(s["type"], 9))

    # One line per transition rather than one per poll, so the output reads as a
    # history of what happened instead of a snapshot repeated every few seconds.
    if last_stages is None:
        print(
            f"[{time.strftime('%H:%M:%S')}] "
            + " · ".join(f"{labels.get(s['type'], s['type'])}: {s['status']}" for s in ordered),
            flush=True,
        )
    else:
        for stage in ordered:
            name, status = labels.get(stage["type"], stage["type"]), stage["status"]
            if last_stages.get(stage["type"]) == status:
                continue
            if status == "leased":
                stage_started[stage["type"]] = time.time()
                print(f"[{time.strftime('%H:%M:%S')}] {name} started", flush=True)
            elif status in {"succeeded", "failed"}:
                took = f" in {elapsed(stage_started[stage['type']])}" if stage["type"] in stage_started else ""
                print(
                    f"[{time.strftime('%H:%M:%S')}] {name} {'ok' if status == 'succeeded' else 'FAILED'}{took}",
                    flush=True,
                )
            else:
                print(f"[{time.strftime('%H:%M:%S')}] {name} {status}", flush=True)
    last_stages = {s["type"]: s["status"] for s in ordered}

    # A page is reported when it appears and again whenever it grows, because a
    # page being rewritten is the clearest sign the run is still doing something.
    for page in sorted(progress.get("pages", []), key=lambda p: p["firstSeenAt"]):
        path, size = page["documentPath"], page["bytes"]
        if path not in seen:
            seen[path] = size
            print(f"    + {path:<44} {size:>7,} bytes  {elapsed(started):>7}  {page['title'][:44]}", flush=True)
        elif size != seen[path]:
            delta = size - seen[path]
            seen[path] = size
            print(f"    ~ {path:<44} {size:>7,} bytes  {delta:+,}", flush=True)

    status = progress.get("status")
    if status in {"succeeded", "failed", "completed"}:
        total = sum(seen.values())
        print(f"\nBuild {status} after {elapsed(started)} — {len(seen)} page(s), {total:,} bytes written.", flush=True)
        for path, size in sorted(seen.items()):
            print(f"    {path:<44} {size:>7,} bytes", flush=True)
        # Pages are written to disk, then checked against the checkpoint. One that
        # cites nothing the repository actually says is withheld, so "written" and
        # "published" are different numbers and it is worth saying so.
        print("Published pages appear at https://app.usejina.com/context", flush=True)
        sys.exit(0 if status != "failed" else 1)
    time.sleep(poll)
PY
