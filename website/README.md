# Orbital website

The public docs site (Astro + Starlight), served from `website/` as its own
package.

```sh
cd website
npm install
npm run dev      # http://localhost:4321/orbital
npm run build    # static site → dist/
```

Screenshots in `src/assets/screenshots/` were captured from the real app running
against a sandbox profile (`ORBITAL_USER_DATA`) populated with fake demo
projects (nebula-shop, comet-api, stardust-blog) — see
`.claude/skills/run-orbital` for the driver used to script them.

## Deployment

Pushes to `main` that touch `website/` trigger `.github/workflows/docs.yml`,
which builds the site and deploys it to **GitHub Pages** via the Pages actions
flow (no `gh-pages` branch). The workflow enables Pages on first run; the site
serves at <https://jimbuck.github.io/orbital>.

`site`/`base` in `astro.config.mjs` match that URL. If you later move to a
custom domain, change `site`, drop `base`, and add a `CNAME` via the Pages
settings.
