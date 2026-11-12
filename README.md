# Snip

Snip is a small URL shortener with one Bun API and two clients: an Angular web
app and a Node.js CLI. Each component lives at the root of its own branch and
is mounted here as a submodule. The `main` branch pins the exact component
commits; `bundle` is generated release output.

## API contract

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| `POST` | `/api/links` | `{ "url": "https://…" }` | `201` with `{ code, url, shortUrl, hits, createdAt }`; `400` for invalid input |
| `GET` | `/api/links` | — | `200` with all links |
| `GET` | `/:code` | — | `302` to the original URL and increments hits; `404` if unknown |

Links are held in memory and are cleared when the backend restarts.

## Clone

Clone with submodules populated:

```sh
git clone --recurse-submodules https://github.com/Sterntaler79/snipdemo-day1.git
```

A plain clone leaves the component folders empty. If you already cloned without
submodules, run `git submodule update --init --recursive`.

## Run the components

Start the backend in one terminal:

```sh
cd backend
bun start
```

In another terminal, start the web app:

```sh
cd frontend
npm install
npx ng serve
```

Open `http://localhost:4200`; the API listens on `http://localhost:3000`.

In a third terminal, use the CLI against the same API:

```sh
cd cli
node cli.js help
node cli.js add https://example.com
node cli.js ls
```

Set `SNIP_API` to use a different backend origin.

## Update and release workflow

Make and push a component change from inside its submodule. Then update and
commit that gitlink in `main`:

```sh
git -C backend add -A
git -C backend commit -m "Describe backend change"
git -C backend push
git submodule update --remote backend
git add backend
git commit -m "Bump backend submodule"
git push
```

Run `node scripts/build-bundle.mjs` to regenerate the release branch. The
hourly/manual bundle workflow runs the same script with `--push`; a changed
`bundle` gitlink on `main` triggers the Docker image workflow.

`bundle/` is generated output: do not hand-edit its files. The builder commits
inside `bundle`, then updates the pinned gitlinks in `main`. Its second run
should be a no-op when the inputs have not changed.
