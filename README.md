<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/57e77e83-47ac-4e01-a0c9-4476792be090

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## GPS, land documents, and evidence quality

GPS tracks are filtered and farm polygons are validated server-side with Turf.js. Optional configuration:

- `VITE_GPS_MAX_ACCURACY_METERS` (default `30`)
- `VITE_GPS_MAX_WALK_SPEED_MPS` (default `3`)

Land document uploads accept PDF, JPG/JPEG, and PNG up to 10 MB. `VITE_LAND_DOCUMENT_MAX_BYTES` can override the limit, and `LAND_DOCUMENT_STORAGE_DIR` can select a private storage directory. The default upload location is `private_uploads/land-documents`, which is excluded from version control and is not served as a public asset.

No OCR provider is configured in this demo. Uploads therefore report `OCR_PROVIDER_UNAVAILABLE`; users can enter and human-confirm land identifiers, but confirmation is not official verification. Admin and officer claim dossiers show deterministic Evidence Quality separately from model confidence. Existing sample satellite/model records are classified as demo data.

Each farmer can register up to 3 distinct farms. Registration rejects matching parcel identifiers and near-identical farm polygons; `FARM_DUPLICATE_IOU_THRESHOLD` configures the duplicate polygon IoU cutoff (default `0.9`, allowed range `0.8`–`1`). `FARM_MAX_AREA_ACRES` sets the server-side maximum accepted area (default `10000`).

Run focused checks with `npm test`, TypeScript validation with `npm run lint`, and the frontend production build with `npm run build`.
