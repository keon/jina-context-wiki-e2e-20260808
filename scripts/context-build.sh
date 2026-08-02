#!/usr/bin/env bash
# Start or follow a Board-native Context build.
#
# The task graph is dynamic: research subjects, pages, audits, challenges, and
# repairs are created as the agents discover the repository. This watcher
# reports tasks by stable id as they appear instead of assuming a fixed stage
# sequence.
#
# Usage:
#   scripts/context-build.sh <owner/repository> [options]
#   scripts/context-build.sh --watch <build-id>
#   scripts/context-build.sh --retry-failed <build-id> [--reason <text>]
#
# Options:
#   --ref <name>               Git ref. Default: main unless repository identity supplies one.
#   --budget <seconds>         Build budget, 300..21600. Default: 5400.
#   --detail <level>           concise | standard | thorough. Default: server policy.
#   --watch <build-id>         Follow an existing build without starting another.
#   --retry-failed <build-id>  Atomically retry every recoverable failed leaf, then follow the build.
#   --reason <text>            Operator audit reason used with --retry-failed.
#   --page <path>              Print one unpublished checkpoint page, then exit.
set -euo pipefail

API="${JINA_API_URL:-https://jina-api-m56inn6iva-uc.a.run.app}"
TENANT="${JINA_TENANT_ID:-eff0efc9-b103-494a-b7a3-1ae7f95c2d26}"
POLL_SECONDS="${POLL_SECONDS:-5}"

repository=""
ref=""
budget=5400
detail=""
watch_build=""
retry_failed_build=""
retry_reason="retry every recoverable failed Board leaf"
page_path=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) ref="${2:-}"; shift 2 ;;
    --budget) budget="${2:-}"; shift 2 ;;
    --detail) detail="${2:-}"; shift 2 ;;
    --watch) watch_build="${2:-}"; shift 2 ;;
    --retry-failed) retry_failed_build="${2:-}"; shift 2 ;;
    --reason) retry_reason="${2:-}"; shift 2 ;;
    --page) page_path="${2:-}"; shift 2 ;;
    -h|--help)
      awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
      exit 0
      ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *)
      if [[ -n "$repository" ]]; then
        echo "only one repository may be supplied" >&2
        exit 2
      fi
      repository="$1"
      shift
      ;;
  esac
done

if [[ -z "$repository" && -z "$watch_build" && -z "$retry_failed_build" ]]; then
  echo "usage: scripts/context-build.sh <owner/repository> [--ref main] [--budget 5400] [--detail thorough]" >&2
  echo "       scripts/context-build.sh --watch <build-id>" >&2
  echo "       scripts/context-build.sh --retry-failed <build-id> [--reason <text>]" >&2
  exit 2
fi
if [[ -n "$retry_failed_build" && ( -n "$repository" || -n "$watch_build" ) ]]; then
  echo "--retry-failed cannot be combined with a repository or --watch" >&2
  exit 2
fi
if [[ -z "$retry_reason" || ${#retry_reason} -gt 2000 ]]; then
  echo "--reason must contain between 1 and 2000 characters" >&2
  exit 2
fi
if [[ -n "$repository" && ! "$repository" =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]]; then
  echo "repository must be owner/name" >&2
  exit 2
fi
if [[ ! "$budget" =~ ^[0-9]+$ ]] || ((budget < 300 || budget > 21600)); then
  echo "--budget must be an integer from 300 through 21600" >&2
  exit 2
fi
if [[ -n "$detail" && "$detail" != "concise" && "$detail" != "standard" && "$detail" != "thorough" ]]; then
  echo "--detail must be concise, standard, or thorough" >&2
  exit 2
fi
if [[ ! "$POLL_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "POLL_SECONDS must be a positive integer" >&2
  exit 2
fi

for tool in curl python3; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }
done

# Local dev-up writes this token into /tmp/jina-dev.env. Production operators
# may load the same internal service credential from Secret Manager.
TOKEN="${JINA_INTERNAL_TOKEN:-}"
if [[ -z "$TOKEN" ]] && command -v gcloud >/dev/null; then
  TOKEN="$(gcloud secrets versions access latest --secret=jina-internal-api-token 2>/dev/null || true)"
fi
if [[ -z "$TOKEN" ]]; then
  echo "No internal API token. For local use, run scripts/dev-up.sh and then:" >&2
  echo "  source /tmp/jina-dev.env" >&2
  exit 1
fi

auth=(
  -H "authorization: Bearer $TOKEN"
  -H "x-jina-tenant-id: $TENANT"
  -H "x-jina-principal-id: tenant:$TENANT"
)

urlencode() {
  python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"
}

api_get() {
  curl -fsS "${auth[@]}" "$API$1"
}

api_post() {
  curl -fsS "${auth[@]}" -H 'content-type: application/json' -d "$2" "$API$1"
}

if [[ -n "$page_path" ]]; then
  if [[ -z "$watch_build" ]]; then
    echo "--page requires --watch <build-id>" >&2
    exit 2
  fi
  api_get "/context/builds/$(urlencode "$watch_build")/page?path=$(urlencode "$page_path")" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["page"]["bodyMarkdown"])'
  exit 0
fi

if [[ -n "$retry_failed_build" ]]; then
  encoded_build="$(urlencode "$retry_failed_build")"
  progress="$(api_get "/context/builds/${encoded_build}/progress")" || {
    echo "Could not read retry eligibility for build $retry_failed_build." >&2
    exit 1
  }
  retry_body="$(
    printf '%s' "$progress" |
      python3 -c '
import json
import sys
import uuid

reason = sys.argv[1]
progress = json.load(sys.stdin)
eligibility = progress.get("retryEligibility")
if not isinstance(eligibility, dict):
    raise SystemExit("API did not expose operator retry eligibility for this credential")
if not eligibility.get("eligible"):
    blockers = eligibility.get("blockers") or []
    detail = "; ".join(str(item.get("detail", "unknown blocker")) for item in blockers if isinstance(item, dict))
    fallback = detail or "no recoverable failed leaves"
    raise SystemExit(f"Build is not batch-retryable: {fallback}")
task_ids = eligibility.get("recoverableTaskIds")
if not isinstance(task_ids, list) or not task_ids:
    raise SystemExit("API marked the build retryable without recoverable task ids")
print(json.dumps({
    "taskIds": task_ids,
    "requestKey": f"operator-cli:{uuid.uuid4()}",
    "reason": reason,
}, separators=(",", ":")))
' "$retry_reason"
  )" || exit 1
  echo "Retrying $(python3 -c 'import json,sys; print(len(json.load(sys.stdin)["taskIds"]))' <<<"$retry_body") failed Board leaf/leaves…"
  retry_response="$(api_post "/context/builds/${encoded_build}/retry" "$retry_body")" || {
    echo "Could not schedule the atomic batch retry." >&2
    exit 1
  }
  python3 -c '
import json
import sys

response = json.load(sys.stdin)
tasks = response.get("tasks") or []
reopened = response.get("reopenedTaskIds") or []
print(f"Batch retry accepted; {len(tasks)} explicit failure branch(es), "
      f"{len(reopened)} total task(s) reopened.")
' <<<"$retry_response"
  watch_build="$retry_failed_build"
fi

build_id="$watch_build"
if [[ -z "$build_id" ]]; then
  body="$(
    python3 - "$repository" "$ref" "$budget" "$detail" <<'PY'
import json
import sys
import uuid

repository, ref, budget, detail = sys.argv[1:5]
request = {
    "repository": repository,
    "derivationBudgetSeconds": int(budget),
    "requestKey": f"local-{uuid.uuid4()}",
}
if ref:
    request["ref"] = ref
if detail:
    request["derivationDetail"] = detail
print(json.dumps(request, separators=(",", ":")))
PY
  )"
  echo "Starting Board-native Context for $repository (budget ${budget}s${detail:+, $detail})…"
  response="$(
    curl -fsS "${auth[@]}" -H 'content-type: application/json' \
      -d "$body" "$API/context/build"
  )" || {
    echo "Could not start the build." >&2
    exit 1
  }
  build_id="$(
    python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("build", {}).get("id", ""))
except Exception:
    print("")' <<<"$response"
  )"
  if [[ -z "$build_id" ]]; then
    echo "API did not return a build id:" >&2
    echo "$response" | head -c 1000 >&2
    echo >&2
    exit 1
  fi
fi

echo "Build $build_id — following its dynamic task board."
echo "Ctrl-C stops this watcher; leased work and checkpoints remain resumable."
echo

python3 - "$API" "$TOKEN" "$TENANT" "$build_id" "$POLL_SECONDS" "${JINA_DEV_STATE_DIR:-}" <<'PY'
import collections
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

api, token, tenant, build_id, poll_value, local_state_dir = sys.argv[1:7]
poll = int(poll_value)
headers = {
    "authorization": f"Bearer {token}",
    "x-jina-tenant-id": tenant,
    "x-jina-principal-id": f"tenant:{tenant}",
}


def get(path):
    request = urllib.request.Request(api + path, headers=headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def elapsed(since):
    seconds = int(time.time() - since)
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours}h{minutes:02d}m{seconds:02d}s" if hours else f"{minutes}m{seconds:02d}s"


def status_label(status):
    return {
        "triage": "materializing",
        "queued": "queued",
        "blocked": "waiting",
        "leased": "running",
        "in_progress": "running",
        "in_review": "reviewing",
        "done": "done",
        "failed": "FAILED",
        "canceled": "canceled",
        "superseded": "superseded",
    }.get(status, status)


def describe(stage):
    title = stage.get("title") or stage.get("type") or stage["id"]
    attempt = stage.get("attempt", 0)
    return f"{title} [{stage.get('type', 'task')}, attempt {attempt}]"


started = time.time()
known_tasks = {}
known_pages = {}
last_summary = None
repository = None
ref = None
progress = None

while True:
    try:
        progress = get(f"/context/builds/{urllib.parse.quote(build_id, safe='')}/progress")
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:500]
        print(f"Build progress request failed with HTTP {error.code}: {detail}", file=sys.stderr)
        sys.exit(1)
    except (urllib.error.URLError, TimeoutError) as error:
        print(f"  (transient poll failure: {error})", flush=True)
        time.sleep(poll)
        continue

    repository = progress.get("repository")
    ref = progress.get("ref")
    stages = progress.get("stages", [])
    now = time.strftime("%H:%M:%S")

    for stage in stages:
        task_id = stage["id"]
        status = stage.get("status", "unknown")
        prior = known_tasks.get(task_id)
        if prior is None:
            print(f"[{now}] + {describe(stage)} — {status_label(status)}", flush=True)
        elif prior["status"] != status or prior.get("attempt") != stage.get("attempt"):
            print(
                f"[{now}]   {describe(stage)}: "
                f"{status_label(prior['status'])} → {status_label(status)}",
                flush=True,
            )
        known_tasks[task_id] = dict(stage)

    counts = collections.Counter(stage.get("status", "unknown") for stage in stages)
    summary = tuple(sorted(counts.items()))
    if summary != last_summary:
        readable = " · ".join(
            f"{count} {status_label(status)}" for status, count in sorted(counts.items())
        )
        print(f"           board: {readable or 'no materialized tasks'}", flush=True)
        last_summary = summary

    for page in sorted(progress.get("pages", []), key=lambda item: item["documentPath"]):
        path = page["documentPath"]
        state = (page.get("bytes", 0), page.get("validationStatus"), page.get("checkpointSequence"))
        prior = known_pages.get(path)
        if prior is None:
            print(
                f"           + checkpoint {path:<44} {state[0]:>8,} bytes "
                f"· {state[1]} · pass {state[2]}",
                flush=True,
            )
        elif prior != state:
            delta = state[0] - prior[0]
            print(
                f"           ~ checkpoint {path:<44} {state[0]:>8,} bytes "
                f"({delta:+,}) · {prior[1]} → {state[1]} · pass {state[2]}",
                flush=True,
            )
        known_pages[path] = state

    build_status = progress.get("status")
    if build_status in {"completed", "failed"}:
        break
    time.sleep(poll)

assert progress is not None
print(
    f"\nBuild {progress.get('status')} after {elapsed(started)} — "
    f"{len(known_tasks)} dynamic task(s), {len(known_pages)} checkpoint page(s).",
    flush=True,
)

failed = [stage for stage in known_tasks.values() if stage.get("status") == "failed"]
if failed:
    print("Failed board tasks:", flush=True)
    for stage in failed:
        print(f"  - {describe(stage)}", flush=True)

if progress.get("status") == "failed":
    if local_state_dir:
        print(f"Worker diagnostics are retained under {local_state_dir}.", flush=True)
    sys.exit(1)

# Publication is atomic; only now read the public catalog. PageIndex attachment
# is part of the board root, so a completed build must expose the final release.
query = urllib.parse.urlencode({"repository": repository, "ref": ref})
try:
    catalog = get(f"/context/list?{query}")
except Exception as error:
    print(f"Build completed but the public catalog could not be read: {error}", file=sys.stderr)
    sys.exit(1)

release = catalog.get("release", {})
documents = catalog.get("documents", [])
tree = catalog.get("tree", [])
print(
    f"Published release {release.get('id', '<unknown>')} at "
    f"{str(release.get('commitSha', '<unknown>'))[:12]} with "
    f"{len(documents)} document(s) and {len(tree)} PageIndex root node(s).",
    flush=True,
)
for document in documents:
    logical = document.get("logicalId") or document.get("id") or "unknown"
    print(f"  - {logical}: {document.get('title', 'Untitled')}", flush=True)
PY
