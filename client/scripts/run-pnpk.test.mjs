import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const runnerPath = resolve(dirname(fileURLToPath(import.meta.url)), "run-pnpk.mjs");

const validPacket = () => ({
  pnpk_version: "0.1.0",
  packet_type: "solana_playground_postbuild_proof",
  service: "Solana Playground",
  created_at: "2026-08-21T00:00:00Z",
  sentinel: {
    decision: "pending",
    reason: "Build artifacts must pass verification.",
  },
  postbuild: {
    mode: "verify_build_artifacts",
    artifact_directory: "build",
    required_files: ["index.html", "asset-manifest.json"],
    required_file_extensions: [".js"],
    index_html_must_include: ["<html", "</html>"],
  },
  execution: {
    executable: false,
    payments_executed: false,
    devices_activated: false,
    private_data_moved: false,
    production_failover_triggered: false,
  },
});

const makeFixture = async ({ packet = validPacket(), build = true } = {}) => {
  const directory = await mkdtemp(join(tmpdir(), "solpg-pnpk-"));
  const packetPath = join(directory, ".pnpk");
  await writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`);

  if (build) {
    const buildDirectory = join(directory, "build");
    await mkdir(join(buildDirectory, "static", "js"), { recursive: true });
    await writeFile(join(buildDirectory, "index.html"), "<html><body>Solana Playground</body></html>\n");
    await writeFile(join(buildDirectory, "asset-manifest.json"), "{}\n");
    await writeFile(join(buildDirectory, "static", "js", "main.js"), "console.log('ok');\n");
  }

  return { directory, packetPath };
};

const run = (packetPath) =>
  spawnSync(process.execPath, [runnerPath, packetPath], {
    encoding: "utf8",
  });

test("allows a complete non-executable build proof", async () => {
  const { packetPath } = await makeFixture();
  const result = run(packetPath);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS PNPK post-build proof/);
  assert.match(result.stdout, /\"decision\": \"allowed\"/);
  assert.match(result.stdout, /\"artifact_file_count\": 3/);
});

test("fails closed when the artifact directory is missing", async () => {
  const { packetPath } = await makeFixture({ build: false });
  const result = run(packetPath);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /FAIL PNPK post-build proof/);
});

test("rejects executable packets", async () => {
  const packet = validPacket();
  packet.execution.executable = true;
  const { packetPath } = await makeFixture({ packet });
  const result = run(packetPath);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /execution\.executable must be false/);
});

test("rejects artifact paths outside the packet directory", async () => {
  const packet = validPacket();
  packet.postbuild.artifact_directory = "../build";
  const { packetPath } = await makeFixture({ packet });
  const result = run(packetPath);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /must stay inside the PNPK directory/);
});

test("rejects builds without the required HTML marker", async () => {
  const { directory, packetPath } = await makeFixture();
  await writeFile(join(directory, "build", "index.html"), "<html><body>Incomplete\n");
  const result = run(packetPath);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /index\.html is missing required marker: <\/html>/);
});

test("rejects builds without a JavaScript artifact", async () => {
  const packet = validPacket();
  packet.postbuild.required_file_extensions = [".wasm"];
  const { packetPath } = await makeFixture({ packet });
  const result = run(packetPath);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /no \.wasm build artifacts were found/);
});

test("rejects symbolic links in build artifacts", async (t) => {
  if (process.platform === "win32") {
    t.skip("symbolic link creation is permission-dependent on Windows");
    return;
  }

  const { directory, packetPath } = await makeFixture();
  await symlink("main.js", join(directory, "build", "static", "js", "linked.js"));
  const result = run(packetPath);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /artifact must not be a symbolic link/);
});
