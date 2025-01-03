// src/extension.ts
import assert from "node:assert";
import { createRequire } from "node:module";
import { join } from "node:path";

// src/edgio.ts
import http from "node:http";
import net from "node:net";
async function checkServerReady() {
  const serverInstance = getServerInstance();
  const { localhost: host, port } = serverInstance.ports;
  return new Promise((resolve, reject) => {
    const timeout = 5000;
    const startTime = Date.now();
    const checkPort = () => {
      const socket = new net.Socket;
      socket.once("connect", () => {
        socket.destroy();
        serverInstance.ready = true;
        process.env.EDGIO_SERVER = JSON.stringify(serverInstance);
        resolve(serverInstance);
      }).once("error", () => {
        socket.destroy();
        if (Date.now() - startTime < timeout) {
          checkPort();
        } else {
          reject(new Error(`Server not ready on ${host}:${port} within timeout`));
        }
      });
      socket.connect(port, host);
    };
    checkPort();
  });
}
async function handleEdgioRequest(req, res) {
  const serverInstance = getServerInstance();
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
    throw new Error("EDGIO_SERVER is not set");
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
      try {
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
        logger.info(`${extensionPrefix} setupDirectory: serverInstance: ${JSON.stringify(serverInstance)}`);
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
        await checkServerReady();
        logger.info(`${extensionPrefix} Edgio server ready on http://${serverInstance.ports.localhost}:${serverInstance.ports.port}`);
        return true;
      } catch (error) {
        logger.error(`${extensionPrefix} Error setting up directory: ${error}`);
        return false;
      }
    }
  };
}
function start(options) {
  const config = resolveConfig(options);
  return {
    async handleDirectory(_, componentPath) {
      const serverInstance = getServerInstance();
      if (!serverInstance?.ready) {
        logger.error(`${extensionPrefix} Edgio server is not ready`);
        return false;
      }
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
