#!/usr/bin/env bash
set -euo pipefail

: "${GCP_PROJECT_ID:?GCP_PROJECT_ID is required}"
: "${GCP_CLOUD_BUILD_REGION:?GCP_CLOUD_BUILD_REGION is required}"
: "${CLOUD_BUILD_ID:?CLOUD_BUILD_ID is required}"

build_description="$(gcloud builds describe "${CLOUD_BUILD_ID}" \
  --project="${GCP_PROJECT_ID}" \
  --region="${GCP_CLOUD_BUILD_REGION}" \
  --format='value(buildTriggerId,createTime)')"
read -r trigger_id current_create_time <<<"${build_description}"

# Operator-submitted builds have no trigger id. They are deliberately not
# serialized with the automatic branch lane; operators must inspect active
# staging builds before using the documented manual command.
if [[ -z "${trigger_id}" || -z "${current_create_time}" ]]; then
  printf 'Manual Cloud Build %s has no trigger id; skipping branch-lane serialization\n' \
    "${CLOUD_BUILD_ID}"
  exit 0
fi

while true; do
  # Stream the response over stdin. Cloud Build records can contain enough
  # metadata to exceed Linux's argv/environment limit if the JSON is exported
  # as an environment variable before starting Python.
  older_builds="$(gcloud builds list \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_CLOUD_BUILD_REGION}" \
    --limit=100 \
    --format=json | \
    TRIGGER_ID="${trigger_id}" \
    CURRENT_BUILD_ID="${CLOUD_BUILD_ID}" \
    CURRENT_CREATE_TIME="${current_create_time}" \
    python3 -c '
import json
import os
import sys

active = {"QUEUED", "PENDING", "WORKING"}
for build in json.load(sys.stdin):
    if (
        build.get("id") != os.environ["CURRENT_BUILD_ID"]
        and build.get("buildTriggerId") == os.environ["TRIGGER_ID"]
        and build.get("createTime", "") < os.environ["CURRENT_CREATE_TIME"]
        and build.get("status") in active
    ):
        print(build["id"])
')"
  if [[ -z "${older_builds}" ]]; then
    printf 'Cloud Build %s owns the staging deployment lane\n' "${CLOUD_BUILD_ID}"
    exit 0
  fi
  printf 'Waiting for older staging build(s) before deployment: %s\n' \
    "$(tr '\n' ' ' <<<"${older_builds}" | sed 's/[[:space:]]*$//')"
  sleep 15
done
