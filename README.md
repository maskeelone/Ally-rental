# Ally Rentals LLC on Netlify

- Site:  https://YOUR-SITE.netlify.app/
- Admin: https://YOUR-SITE.netlify.app/admin

## Deploy (GitHub, recommended)
1. Create a new PRIVATE GitHub repository and upload everything in this folder to it.
2. In Netlify: Add new site > Import an existing project > pick the repo.
   Build settings are read from netlify.toml. Leave the build command empty.
3. Site configuration > Environment variables > add ADMIN_TOKEN with your admin token.
4. Deploys > Trigger deploy > Deploy site (so the token is picked up).
5. Open /admin and sign in.

## Deploy (Netlify CLI)
    npm install -g netlify-cli
    netlify login
    netlify init        (link or create the site)
    netlify deploy --prod

Drag-and-drop deploys will not work: the backend needs its dependency installed during the build.

## Where things live
- public/index.html          the public site
- public/admin/index.html    the admin page
- netlify/functions/api.mjs  the backend (API, photo hosting, admin sessions)
- Listings, messages and photos are stored in Netlify Blobs, so they survive redeploys.

## Notes
- Photos are resized in the browser before upload. The limit is about 4 MB per photo.
- If ADMIN_TOKEN is not set, the token falls back to moses7734. Set your own before sharing the link.
- Optional: SESSION_SECRET adds an extra secret for signing admin sessions.
- Local preview: npm install, then npx netlify dev.
