// src/extension.ts
import assert from "node:assert";
import { threadId } from "node:worker_threads";

// src/edgio.ts
import http from "node:http";
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
export {
  startOnMainThread,
  start
};
