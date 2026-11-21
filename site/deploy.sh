#!/usr/bin/env bash
# Deploys lima.liamhosfeld.com. The domain is a Cloud Run domain mapping in
# stem-471602/us-east1 that routes to the service named stem-portfolio-host,
# so redeploying that service is all it takes (no DNS or certificate change).
set -euo pipefail
cd "$(dirname "$0")"
cp ../browser/branding/lima-app-icon.svg public/lima.svg
gcloud run deploy stem-portfolio-host \
  --project stem-471602 --region us-east1 --source . \
  --allow-unauthenticated --port 8080 --cpu 1 --memory 256Mi \
  --min-instances 0 --max-instances 3 --concurrency 200 --quiet
curl -fsS https://lima.liamhosfeld.com/health
