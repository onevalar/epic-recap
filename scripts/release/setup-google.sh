#!/usr/bin/env bash
# Run only after the owner authorizes the exact Google/GitHub publishing access.
# Intended for Google Cloud Shell; creates no private keys and assigns no project roles.
set -euo pipefail
release_project="${1:?Usage: bash scripts/release/setup-google.sh PROJECT_ID}"
[[ "$release_project" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || exit 1
release_pool=epic-recap-github
release_provider=github
release_service="epic-recap-publisher@${release_project}.iam.gserviceaccount.com"
release_number=$(gcloud projects describe "$release_project" --format='value(projectNumber)')
gcloud services enable chromewebstore.googleapis.com iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com --project="$release_project"
if ! gcloud iam service-accounts describe "$release_service" --project="$release_project" >/dev/null 2>&1; then
  gcloud iam service-accounts create epic-recap-publisher --display-name='Epic Recap store releases' --project="$release_project"
fi
if ! gcloud iam workload-identity-pools describe "$release_pool" --location=global --project="$release_project" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$release_pool" --location=global --display-name='Epic Recap GitHub' --project="$release_project"
fi
release_condition="assertion.repository_id == '1437784855' && assertion.repository_owner_id == '217557060' && assertion.ref == 'refs/heads/main' && assertion.sub == 'repo:onevalar/epic-recap:environment:chrome-web-store'"
release_mapping='google.subject=assertion.sub,attribute.repository_id=assertion.repository_id'
if gcloud iam workload-identity-pools providers describe "$release_provider" --workload-identity-pool="$release_pool" --location=global --project="$release_project" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers update-oidc "$release_provider" --workload-identity-pool="$release_pool" --location=global --issuer-uri=https://token.actions.githubusercontent.com --attribute-mapping="$release_mapping" --attribute-condition="$release_condition" --project="$release_project"
else
  gcloud iam workload-identity-pools providers create-oidc "$release_provider" --workload-identity-pool="$release_pool" --location=global --issuer-uri=https://token.actions.githubusercontent.com --attribute-mapping="$release_mapping" --attribute-condition="$release_condition" --project="$release_project"
fi
gcloud iam service-accounts add-iam-policy-binding "$release_service" --project="$release_project" --role=roles/iam.workloadIdentityUser --member="principal://iam.googleapis.com/projects/${release_number}/locations/global/workloadIdentityPools/${release_pool}/subject/repo:onevalar/epic-recap:environment:chrome-web-store"
printf '\nGCP_WORKLOAD_IDENTITY_PROVIDER=projects/%s/locations/global/workloadIdentityPools/%s/providers/%s\nGCP_SERVICE_ACCOUNT=%s\n' "$release_number" "$release_pool" "$release_provider" "$release_service"
printf '\nNext: add this service account in Chrome Web Store Account settings, set these two GitHub environment variables, then run the read-only status workflow.\n'
