// src/extension.ts
import assert from "node:assert";
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
  logger.info(`${extensionPrefix}- startOnMainThread`);
  return {
    async setupDirectory(_, componentPath) {
      logger.info(`${extensionPrefix} - setupDirectory - ${componentPath}`);
      return true;
    }
  };
}
function start(options) {
  const config = resolveConfig(options);
  logger.info(`${extensionPrefix}- start`);
  return {
    async handleDirectory(_, componentPath) {
      logger.info(`${extensionPrefix}- handleDirectory`);
      options.server.http(async (request, nextHandler) => {
        const { _nodeRequest: req, _nodeResponse: res } = request;
        logger.debug(`${extensionPrefix} Handling request: ${req.url.split("?")[0]}`);
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
