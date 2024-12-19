import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/extension.ts
import assert from "node:assert";

// src/edgio.ts
import { join } from "node:path";
import http from "node:http";
import net from "node:net";
var serveStaticAssets;
var runWithServerless;
var edgioPorts;
try {
  const corePath = __require.resolve("@edgio/cli/constants/core.js");
  const serveStaticAssetsPath = __require.resolve("@edgio/cli/serverless/serveStaticAssets.js");
  const runWithServerlessPath = __require.resolve("@edgio/cli/utils/runWithServerless.js");
  serveStaticAssets = await import(serveStaticAssetsPath).then((mod) => mod.default);
  runWithServerless = await import(runWithServerlessPath).then((mod) => mod.default);
  const edgioCore = await import(corePath);
  edgioPorts = edgioCore.PORTS;
} catch (error) {
  console.error(`Failed to resolve or import serveStaticAssets or runWithServerless: ${error}`);
}
var cwd = process.cwd();
var edgioPathName = ".edgio/";
var edgioCwd;
var originalChdir = process.chdir;
process.chdir = (directory) => {
  if (directory.includes(edgioPathName)) {
    edgioCwd = directory;
    return;
  }
  originalChdir(directory);
};
var originalCwd = process.cwd;
process.cwd = () => {
  const stack = new Error().stack;
  const cwdLines = stack?.split(`
`).filter((line) => line.includes("process.cwd") || line.includes(edgioPathName)) ?? [];
  if (cwdLines.length > 0 && edgioCwd) {
    return edgioCwd;
  }
  return originalCwd();
};
var production = true;
var edgioDir = join(cwd, ".edgio");
var assetsDir = join(edgioDir, "s3");
var permanentAssetsDir = join(edgioDir, "s3-permanent");
var assetPort = 3002;
var staticAssetDirs = [assetsDir, permanentAssetsDir];
var withHandler = false;
var startEdgio = async () => {
  const readyPromise = checkServerReady();
  await serveStaticAssets(staticAssetDirs, assetPort);
  await runWithServerless(edgioDir, { devMode: !production, withHandler });
  return readyPromise;
};
async function checkServerReady() {
  const { localhost, port } = edgioPorts;
  return new Promise((resolve, reject) => {
    const timeout = 5000;
    const startTime = Date.now();
    const checkPort = () => {
      const socket = new net.Socket;
      socket.once("connect", () => {
        socket.destroy();
        resolve({ host: localhost, port });
      }).once("error", () => {
        socket.destroy();
        if (Date.now() - startTime < timeout) {
          checkPort();
        } else {
          reject(new Error(`Server not ready on ${localhost}:${port} within timeout`));
        }
      });
      socket.connect(port, localhost);
    };
    checkPort();
  });
}
async function handleEdgioRequest(req, res) {
  const { host, port } = await checkServerReady();
  const options = {
    method: req.method,
    headers: req.headers,
    hostname: host,
    port,
    path: req.url
  };
  const proxy = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });
  req.pipe(proxy, { end: true });
  return new Promise((resolve, reject) => {
    proxy.on("error", (err) => {
      reject(err);
    });
    proxy.on("finish", () => {
      resolve(res);
    });
  });
}
var edgio_default = startEdgio;

// src/extension.ts
var extensionPrefix = "[edgio-runner]";
function assertType(name, option, expectedType) {
  if (option) {
    const found = typeof option;
    assert.strictEqual(found, expectedType, `${name} must be type ${expectedType}. Received: ${found}`);
  }
}
function resolveConfig(options) {
  assertType("edgioPath", options.edgioPath, "string");
  return {
    edgioPath: options.edgioPath
  };
}
function startOnMainThread(options) {
  const config = resolveConfig(options);
  return {
    async setupDirectory(_, componentPath) {
      return true;
    }
  };
}
function start(options) {
  const config = resolveConfig(options);
  logger.info(`${extensionPrefix} Starting Edgio extension...`);
  return {
    async handleDirectory(_, componentPath) {
      const { host, port } = await edgio_default();
      logger.info(`${extensionPrefix} Edgio ready on http://${host}:${port}`);
      options.server.http(async (request, nextHandler) => {
        const { _nodeRequest: req, _nodeResponse: res } = request;
        logger.debug(`${extensionPrefix} Handling request: ${req.url.split("?")[0]}`);
        await handleEdgioRequest(req, res);
        logger.debug(`${extensionPrefix} Finished handling request: ${req.url.split("?")[0]}`);
        nextHandler(request);
      });
      return true;
    }
  };
}
export {
  startOnMainThread,
  start
};
