import assert from 'node:assert';
import startEdgio, { checkServerReady, handleEdgioRequest } from './edgio';

const extensionPrefix = '[edgio-runner]';

/**
 * @typedef {Object} ExtensionOptions - The configuration options for the extension.
 * @property {string} edgioPath - The path to the edgio file.
 */
export type ExtensionOptions = Partial<{
	edgioPath: string;
}> & {
	[key: string]: any;
};

/**
 * Assert that a given option is a specific type.
 * @param {string} name The name of the option.
 * @param {any=} option The option value.
 * @param {string} expectedType The expected type (i.e. `'string'`, `'number'`, `'boolean'`, etc.).
 */
function assertType(name: string, option: any, expectedType: string) {
	if (option) {
		const found = typeof option;
		assert.strictEqual(found, expectedType, `${name} must be type ${expectedType}. Received: ${found}`);
	}
}

/**
 * Resolves the incoming extension options into a config for use throughout the extension.
 * @param {ExtensionOptions} options - The options object to be resolved into a configuration.
 * @returns {Required<ExtensionOptions>}
 */
function resolveConfig(options: ExtensionOptions) {
	assertType('edgioPath', options.edgioPath, 'string');

	return {
		edgioPath: options.edgioPath,
	};
}

/**
 * This method is executed once, on the main thread, and is responsible for
 * returning a Resource Extension that will subsequently be executed once,
 * on the main thread.
 *
 * The Resource Extension is responsible for...
 *
 * @param {ExtensionOptions} options
 * @returns
 */
export function startOnMainThread(options: ExtensionOptions) {
	const config = resolveConfig(options);

	return {
		async setupDirectory(_: any, componentPath: string) {
			return true;
		},
	};
}

/**
 * This method is executed on each worker thread, and is responsible for
 * returning a Resource Extension that will subsequently be executed on each
 * worker thread.
 *
 * @param {ExtensionOptions} options
 * @returns
 */
export function start(options: ExtensionOptions) {
	const config = resolveConfig(options);

	logger.info(`${extensionPrefix} Starting Edgio extension...`);

	return {
		async handleDirectory(_: any, componentPath: string) {
			// Run the Edgio handler
			const readyPromise = await startEdgio();
			const { host, port } = await readyPromise;
			logger.info(`${extensionPrefix} Edgio ready on http://${host}:${port}`);

			options.server.http(async (request: any, nextHandler: any) => {
				const { _nodeRequest: req, _nodeResponse: res } = request;

				logger.debug(`${extensionPrefix} Handling request: ${req.url.split('?')[0]}`);

				await handleEdgioRequest(req, res);

				logger.debug(`${extensionPrefix} Finished handling request: ${req.url.split('?')[0]}`);

				nextHandler(request);
			});

			return true;
		},
	};
}
