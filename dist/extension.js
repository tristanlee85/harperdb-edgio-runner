// src/extension.ts
import assert from "node:assert";
import { openSync, writeSync, unlinkSync } from "node:fs";
import { setTimeout as setTimeout2 } from "node:timers/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { threadId } from "node:worker_threads";

// src/edgio.ts
import http from "node:http";
import net from "node:net";
import { setTimeout } from "node:timers/promises";
function createServerReadyHandler() {
  let serverReadyPromise = null;
  return {
    waitForServerReady: function() {
      if (serverReadyPromise) {
        return serverReadyPromise;
      }
      serverReadyPromise = new Promise((resolve, reject) => {
        const serverInstance = getServerInstance();
        if (!serverInstance) {
          reject(new Error("Server instance is not set"));
          return;
        }
        const { localhost: host, port } = serverInstance.ports;
        const checkPort = () => {
          const socket = new net.Socket;
          socket.once("connect", () => {
            socket.destroy();
            serverInstance.ready = true;
            process.env.EDGIO_SERVER = JSON.stringify(serverInstance);
            resolve(serverInstance);
          }).once("error", () => {
            socket.destroy();
            checkPort();
          });
          socket.connect(port, host);
        };
        checkPort();
      });
      const timeoutPromise = setTimeout(5000).then(() => {
        throw new Error("Edgio server did not become ready within 5000ms.");
      });
      return Promise.race([serverReadyPromise, timeoutPromise]);
    },
    isServerReady: function() {
      const serverInstance = getServerInstance();
      return serverInstance?.ready ?? false;
    }
  };
}
async function handleEdgioRequest(req, res) {
  const serverInstance = getServerInstance();
  if (!serverInstance) {
    throw new Error("Unable to handle Edgio request because server instance is not set.");
  }
  const { localhost: host, port } = serverInstance.ports;
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
function getServerInstance() {
  if (!process.env.EDGIO_SERVER) {
    return null;
  }
  return JSON.parse(process.env.EDGIO_SERVER);
}

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
    }
  };
}
function start(options) {
  const config = resolveConfig(options);
  return {
    async handleDirectory(_, componentPath) {
      logger.info(`${extensionPrefix} handleDirectory (pid: ${process.pid}, threadId: ${threadId})`);
      await prepareServer(config, componentPath, options.server);
      options.server.http(async (request, nextHandler) => {
        const { _nodeRequest: req, _nodeResponse: res } = request;
        logger.info(`${extensionPrefix} Handling request: ${req.url.split("?")[0]}`);
        await handleEdgioRequest(req, res);
        logger.info(`${extensionPrefix} Finished handling request: ${req.url.split("?")[0]}`);
        nextHandler(request);
      });
      return true;
    }
  };
}
async function prepareServer(config, componentPath, server) {
  const edgioLockPath = join(tmpdir(), ".edgio-server.lock");
  const { waitForServerReady, isServerReady } = createServerReadyHandler();
  let attempt = 0;
  const maxAttempts = 20;
  while (attempt < maxAttempts) {
    if (isServerReady()) {
      logger.info(`${extensionPrefix} Edgio server already running`);
      break;
    }
    try {
      const buildLockFD = openSync(edgioLockPath, "wx");
      writeSync(buildLockFD, process.pid.toString());
      logger.info(`${extensionPrefix} Edgio server lock created (pid: ${process.pid}, threadId: ${threadId})`);
    } catch (error) {
      if (error.code === "EEXIST") {
        await setTimeout2(500);
        attempt++;
        continue;
      }
      throw error;
    }
    logger.info(`${extensionPrefix} Preparing Edgio server (pid: ${process.pid})...`);
    const timerStart = performance.now();
    const componentRequire = createRequire(componentPath);
    const serveStaticAssets = (await import(componentRequire.resolve("@edgio/cli/serverless/serveStaticAssets"))).default;
    const runWithServerless = (await import(componentRequire.resolve("@edgio/cli/utils/runWithServerless"))).default;
    const edgioCore = (await import(componentRequire.resolve("@edgio/cli/constants/core"))).default;
    const serverInstance = {
      ports: {
        localhost: edgioCore.PORTS.localhost,
        port: edgioCore.PORTS.port,
        jsPort: edgioCore.PORTS.jsPort,
        assetPort: edgioCore.PORTS.assetPort
      },
      ready: false
    };
    process.env.EDGIO_SERVER = JSON.stringify(serverInstance);
    const cwd = process.cwd();
    const edgioPathName = ".edgio/";
    let edgioCwd;
    const originalChdir = process.chdir;
    if (!process.chdir.hasOwnProperty("__edgio_runner_override")) {
      process.chdir = (directory) => {
        if (directory.includes(edgioPathName)) {
          logger.info(`${extensionPrefix} chdir: Changing cwd to ${directory}`);
          edgioCwd = directory;
          return;
        }
        originalChdir(directory);
      };
      process.chdir.__edgio_runner_override = true;
    }
    const originalCwd = process.cwd;
    if (!process.cwd.hasOwnProperty("__edgio_runner_override")) {
      process.cwd = () => {
        const stack = new Error().stack;
        const cwdLines = stack?.split(`
`).filter((line) => line.includes("process.cwd") || line.includes(edgioPathName)) ?? [];
        if (cwdLines.length >= 2 && edgioCwd) {
          logger.info(`${extensionPrefix} cwd: Returning edgioCwd: ${edgioCwd}`);
          return edgioCwd;
        }
        return originalCwd();
      };
      process.cwd.__edgio_runner_override = true;
    }
    const production = true;
    const edgioDir = join(cwd, ".edgio");
    const assetsDir = join(edgioDir, "s3");
    const permanentAssetsDir = join(edgioDir, "s3-permanent");
    const staticAssetDirs = [assetsDir, permanentAssetsDir];
    const withHandler = false;
    await serveStaticAssets(staticAssetDirs, serverInstance.ports.assetPort);
    await runWithServerless(edgioDir, { devMode: !production, withHandler });
    await waitForServerReady();
    logger.info(`${extensionPrefix} Edgio server ready on http://${serverInstance.ports.localhost}:${serverInstance.ports.port} after ${performance.now() - timerStart}ms (pid: ${process.pid})`);
    unlinkSync(edgioLockPath);
    break;
  }
  if (attempt >= maxAttempts) {
    logger.error(`${extensionPrefix} Max attempts reached. Could not prepare Edgio server.`);
  }
}
export {
  startOnMainThread,
  start
};
