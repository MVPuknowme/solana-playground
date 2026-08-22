#!/usr/bin/env node

import { lstat, readFile, readdir } from "node:fs/promises";
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

const fail = (message) => {
  throw new Error(message);
};

const assert = (condition, message) => {
  if (!condition) fail(message);
};

const resolveInside = (baseDirectory, candidate, fieldName) => {
  assert(
    typeof candidate === "string" && candidate.length > 0,
    `${fieldName} must be a non-empty relative path`
  );
  assert(!isAbsolute(candidate), `${fieldName} must be relative`);

  const target = resolve(baseDirectory, candidate);
  const relativeTarget = relative(baseDirectory, target);
  assert(
    relativeTarget !== ".." &&
      !relativeTarget.startsWith(`..${sep}`) &&
      !isAbsolute(relativeTarget),
    `${fieldName} must stay inside the PNPK directory`
  );

  return target;
};

const assertRegularFile = async (filePath, label) => {
  const info = await lstat(filePath);
  assert(!info.isSymbolicLink(), `${label} must not be a symbolic link`);
  assert(info.isFile(), `${label} must be a regular file`);
  assert(info.size > 0, `${label} must not be empty`);
  return info;
};

const collectFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name);
    assert(!entry.isSymbolicLink(), `artifact must not be a symbolic link: ${entryPath}`);

    if (entry.isDirectory()) files.push(...(await collectFiles(entryPath)));
    else if (entry.isFile()) files.push(entryPath);
  }

  return files;
};

const validatePacket = (packet) => {
  assert(packet && typeof packet === "object" && !Array.isArray(packet), "root must be an object");

  for (const field of [
    "pnpk_version",
    "packet_type",
    "service",
    "created_at",
    "sentinel",
    "postbuild",
    "execution",
  ]) {
    assert(Object.hasOwn(packet, field), `missing required field: ${field}`);
  }

  assert(typeof packet.pnpk_version === "string", "pnpk_version must be a string");
  assert(typeof packet.packet_type === "string", "packet_type must be a string");
  assert(typeof packet.service === "string", "service must be a string");
  assert(!Number.isNaN(Date.parse(packet.created_at)), "created_at must be an ISO-compatible date-time");
  assert(packet.sentinel?.decision === "pending", "sentinel.decision must be pending before verification");

  const execution = packet.execution ?? {};
  for (const field of [
    "executable",
    "payments_executed",
    "devices_activated",
    "private_data_moved",
    "production_failover_triggered",
  ]) {
    assert(execution[field] === false, `execution.${field} must be false`);
  }

  const postbuild = packet.postbuild ?? {};
  assert(postbuild.mode === "verify_build_artifacts", "postbuild.mode is invalid");
  assert(Array.isArray(postbuild.required_files), "postbuild.required_files must be an array");
  assert(
    Array.isArray(postbuild.required_file_extensions) &&
      postbuild.required_file_extensions.length > 0,
    "postbuild.required_file_extensions must be a non-empty array"
  );
  assert(
    Array.isArray(postbuild.index_html_must_include),
    "postbuild.index_html_must_include must be an array"
  );
};

const main = async () => {
  const packetPath = resolve(process.argv[2] ?? ".pnpk");
  const packetDirectory = dirname(packetPath);
  const rawPacket = (await readFile(packetPath, "utf8")).replace(/^\uFEFF/, "");
  const packet = JSON.parse(rawPacket);
  validatePacket(packet);

  const artifactDirectory = resolveInside(
    packetDirectory,
    packet.postbuild.artifact_directory,
    "postbuild.artifact_directory"
  );
  const artifactInfo = await lstat(artifactDirectory);
  assert(!artifactInfo.isSymbolicLink(), "artifact directory must not be a symbolic link");
  assert(artifactInfo.isDirectory(), "artifact directory must be a directory");

  const requiredFiles = {};
  for (const requiredFile of packet.postbuild.required_files) {
    const requiredPath = resolveInside(artifactDirectory, requiredFile, "required file");
    const info = await assertRegularFile(requiredPath, `required file '${requiredFile}'`);
    requiredFiles[requiredFile] = info.size;
  }

  const indexPath = resolveInside(artifactDirectory, "index.html", "index file");
  const indexHtml = await readFile(indexPath, "utf8");
  for (const marker of packet.postbuild.index_html_must_include) {
    assert(
      typeof marker === "string" && marker.length > 0,
      "index_html_must_include values must be non-empty strings"
    );
    assert(indexHtml.includes(marker), `index.html is missing required marker: ${marker}`);
  }

  const artifactFiles = await collectFiles(artifactDirectory);
  const extensionCounts = {};
  for (const extension of packet.postbuild.required_file_extensions) {
    assert(
      typeof extension === "string" && extension.startsWith("."),
      "required file extensions must start with a dot"
    );

    const matchingFiles = artifactFiles.filter((filePath) => extname(filePath) === extension);
    assert(matchingFiles.length > 0, `no ${extension} build artifacts were found`);
    for (const filePath of matchingFiles) {
      await assertRegularFile(filePath, `${extension} artifact`);
    }
    extensionCounts[extension] = matchingFiles.length;
  }

  const proof = {
    pnpk_version: packet.pnpk_version,
    packet_type: `${packet.packet_type}_result`,
    service: packet.service,
    created_at: new Date().toISOString(),
    sentinel: {
      decision: "allowed",
      reason: "Post-build artifacts passed fail-closed verification.",
    },
    proof: {
      artifact_directory: relative(packetDirectory, artifactDirectory) || ".",
      required_files: requiredFiles,
      extension_counts: extensionCounts,
      artifact_file_count: artifactFiles.length,
    },
    execution: packet.execution,
  };

  console.log("PASS PNPK post-build proof");
  console.log(JSON.stringify(proof, null, 2));
};

main().catch((error) => {
  console.error(`FAIL PNPK post-build proof: ${error.message}`);
  process.exitCode = 1;
});
