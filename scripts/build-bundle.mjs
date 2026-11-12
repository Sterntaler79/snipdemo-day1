import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = join(root, "bundle");
const frontendDirectory = join(root, "frontend");
const buildDirectory = join(frontendDirectory, "dist", "snip-frontend", "browser");
const publicDirectory = join(bundleDirectory, "public");
const push = process.argv.includes("--push");

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}.`);
  }
}

function stagedChanges(directory) {
  const result = spawnSync("git", ["diff", "--cached", "--quiet"], {
    cwd: directory,
    stdio: "ignore",
    shell: process.platform === "win32",
  });

  if (result.error) throw result.error;
  if (result.status === 1) return true;
  if (result.status !== 0) throw new Error(`Could not inspect staged changes in ${directory}.`);
  return false;
}

function currentBranch() {
  const result = spawnSync("git", ["branch", "--show-current"], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Could not determine the current branch.");
  return result.stdout.trim();
}

function requireClean(directory) {
  const result = spawnSync("git", ["status", "--porcelain"], {
    cwd: directory,
    encoding: "utf8",
    shell: process.platform === "win32",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Could not inspect working tree ${directory}.`);
  if (result.stdout) throw new Error(`Working tree must be clean before building: ${directory}`);
}

function requireFile(path) {
  return readFile(path).then(
    () => {},
    (error) => {
      if (error.code === "ENOENT") throw new Error(`Required build output is missing: ${path}`);
      throw error;
    },
  );
}

if (currentBranch() !== "main") {
  throw new Error("Run this script from the main branch.");
}
requireClean(root);

run("git", ["submodule", "update", "--init", "--remote", "backend", "frontend", "cli"]);
requireClean(bundleDirectory);
run("npm", ["install"], frontendDirectory);
run("npx", ["ng", "build"], frontendDirectory);
await requireFile(join(buildDirectory, "index.html"));

await mkdir(bundleDirectory, { recursive: true });
await rm(publicDirectory, { recursive: true, force: true });
await mkdir(publicDirectory, { recursive: true });
await cp(buildDirectory, publicDirectory, { recursive: true });
await cp(join(root, "backend", "server.js"), join(bundleDirectory, "server.js"));
await cp(join(root, "cli", "cli.js"), join(bundleDirectory, "cli.js"));
await writeFile(join(bundleDirectory, ".env"), "PUBLIC_DIR=./public\n");
await writeFile(
  join(bundleDirectory, "package.json"),
  `${JSON.stringify({ name: "snip-bundle", private: true, scripts: { start: "bun server.js" } }, null, 2)}\n`,
);
await writeFile(
  join(bundleDirectory, "Dockerfile"),
  [
    "FROM oven/bun:1-alpine",
    "WORKDIR /app",
    "COPY . .",
    "ENV PORT=3000",
    "EXPOSE 3000",
    'CMD ["bun", "server.js"]',
    "",
  ].join("\n"),
);
await writeFile(
  join(bundleDirectory, ".dockerignore"),
  [".git", ".env.*", "node_modules", "npm-debug.log", ""].join("\n"),
);
await writeFile(
  join(bundleDirectory, "railway.json"),
  `${JSON.stringify(
    {
      $schema: "https://railway.com/railway.schema.json",
      build: { builder: "DOCKERFILE" },
      deploy: { healthcheckPath: "/api/links", healthcheckTimeout: 100 },
    },
    null,
    2,
  )}\n`,
);

run("git", ["add", "-A"], bundleDirectory);
if (stagedChanges(bundleDirectory)) {
  run(
    "git",
    [
      "commit",
      "-m",
      "Build generated Snip release bundle",
      "--trailer",
      "Co-authored-by: OpenBot <335604065+openbotgit[bot]@users.noreply.github.com>",
    ],
    bundleDirectory,
  );
  console.log("Generated bundle committed.");
} else {
  console.log("Bundle unchanged.");
}

if (push) run("git", ["push", "origin", "HEAD:bundle"], bundleDirectory);

run("git", ["add", "--", "backend", "frontend", "cli", "bundle"]);
if (stagedChanges(root)) {
  run(
    "git",
    [
      "commit",
      "--only",
      "-m",
      "Update release submodule pointers",
      "--trailer",
      "Co-authored-by: OpenBot <335604065+openbotgit[bot]@users.noreply.github.com>",
      "--",
      "backend",
      "frontend",
      "cli",
      "bundle",
    ],
  );
  console.log("Release submodule pointers committed.");
} else {
  console.log("Submodule pointers unchanged.");
}

if (push) run("git", ["push", "origin", "HEAD:main"]);
