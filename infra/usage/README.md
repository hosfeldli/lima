# Usage collector

Cloud Run service `lima-usage` in `lima-build-prod` (us-central1): https://lima-usage-940267100054.us-central1.run.app

- `POST /v1/report`: one opted-in daily report, validated against a fixed schema (`main.py`), stored as
  `gs://lima-usage-940267100054/installs/<id>/<day>.json`. The bucket is private and deletes objects after 400 days.
- `DELETE /v1/installs/<id>`: removes everything under an ID ("Delete my data").
- Runs as `lima-usage@…`, which can write only to that bucket. Request logs (which hold addresses) are excluded
  from Cloud Logging by the `_Default` sink exclusion `lima-usage-requests`.

Deploy: `gcloud run deploy lima-usage --project lima-build-prod --region us-central1 --source infra/usage
--service-account lima-usage@lima-build-prod.iam.gserviceaccount.com --set-env-vars USAGE_BUCKET=lima-usage-940267100054
--allow-unauthenticated --max-instances 3 --memory 256Mi`. The app reads the URL from `browser/release.json` → `usage.endpoint`.
