# Ally Rentals LLC website

No dependencies. Needs Node 18 or newer. Start with: node server.js

- Site:  http://YOUR-IP:PORT/
- Admin: http://YOUR-IP:PORT/admin   (sign in with your admin token)

## Settings (environment variables, all optional)
- ADMIN_TOKEN   admin token (default: moses7734). Change it before going live.
- PORT / SERVER_PORT   port (Pterodactyl sets SERVER_PORT for you)
- DATA_DIR      where listings, messages and photos are saved (default: ./data)
- TRUST_PROXY=1 set this if the site sits behind nginx or Cloudflare

## Files
- server.js          backend and API
- public/index.html  the public site
- views/admin.html   the admin page (served at /admin, not linked from the site)
- data/              your listings, messages and uploaded photos. Back this folder up.
