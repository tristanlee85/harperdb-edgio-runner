import assert from 'node:assert';
import { openSync, writeSync, unlinkSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { threadId } from 'node:worker_threads';
import { handleEdgioRequest, createServerReadyHandler } from './edgio';
import type { EdgioServerInstance } from './edgio';

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
 * @param {ExtensionOptions} options
 * @returns
 */
export function startOnMainThread(options: ExtensionOptions) {
	const config = resolveConfig(options);

	return {
		async setupDirectory(_: any, componentPath: string) {},
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

	return {
		async handleDirectory(_: any, componentPath: string) {
			logger.info(`${extensionPrefix} handleDirectory (pid: ${process.pid}, threadId: ${threadId})`);
			await prepareServer(config, componentPath, options.server);

			options.server.http(async (request: any, nextHandler: any) => {
				const { _nodeRequest: req, _nodeResponse: res } = request;

				logger.info(`${extensionPrefix} Handling request: ${req.url.split('?')[0]}`);

				await handleEdgioRequest(req, res);

				logger.info(`${extensionPrefix} Finished handling request: ${req.url.split('?')[0]}`);

				nextHandler(request);
			});

			return true;
		},
	};
}

async function prepareServer(config: any, componentPath: string, server: any) {
	const edgioLockPath = join(tmpdir(), '.edgio-server.lock');
	const { waitForServerReady, isServerReady } = createServerReadyHandler();

	let attempt = 0;
	const maxAttempts = 20;

	while (attempt < maxAttempts) {
		if (isServerReady()) {
			logger.info(`${extensionPrefix} Edgio server already running`);
			break;
		}

		// Create a lock file to prevent multiple threads from starting the Edgio server.
		try {
			const buildLockFD = openSync(edgioLockPath, 'wx');
			writeSync(buildLockFD, process.pid.toString());
			logger.info(`${extensionPrefix} Edgio server lock created (pid: ${process.pid}, threadId: ${threadId})`);
		} catch (error: any) {
			// If the lock file already exists, another thread is already preparing the server.
			if (error.code === 'EEXIST') {
				await setTimeout(500);
				attempt++;
				continue;
			}

			throw error;
		}

		logger.info(`${extensionPrefix} Preparing Edgio server (pid: ${process.pid})...`);

		// Log worker threads

		const timerStart = performance.now();
		const componentRequire = createRequire(componentPath);
		const serveStaticAssets = (await import(componentRequire.resolve('@edgio/cli/serverless/serveStaticAssets')))
			.default;
		const runWithServerless = (await import(componentRequire.resolve('@edgio/cli/utils/runWithServerless'))).default;

		// Load the Edgio ports into the shared process.env for all workers to reference.
		// This is necessary because servers such as Next.js will set process.env.PORT AFTER
		// the Edgio server has started. This is problematic because if `@edgio/cli/constants/core.js`
		// is re-imported within a worker thread, then `edgioCore.PORTS.port` will become what
		// Next.js sets it to (e.g. 3001), rather than the default Edgio server's port (e.g. 3000).
		const edgioCore = (await import(componentRequire.resolve('@edgio/cli/constants/core'))).default;
		const serverInstance: EdgioServerInstance = {
			ports: {
				localhost: edgioCore.PORTS.localhost,
				port: edgioCore.PORTS.port,
				jsPort: edgioCore.PORTS.jsPort,
				assetPort: edgioCore.PORTS.assetPort,
			},
			ready: false,
		};
		process.env.EDGIO_SERVER = JSON.stringify(serverInstance);

		const cwd = process.cwd();
		const edgioPathName = '.edgio/';
		let edgioCwd: string | undefined;

		// Edgio will attempt to change the cwd to .edgio/lambda/, but this is not permissible
		// within worker threads. This invocation of process.chdir() becomes a no-op within
		// that context.
		const originalChdir = process.chdir;
		if (!process.chdir.hasOwnProperty('__edgio_runner_override')) {
			process.chdir = (directory) => {
				if (directory.includes(edgioPathName)) {
					logger.info(`${extensionPrefix} chdir: Changing cwd to ${directory}`);
					// Edgio has attempted to change the cwd so future calls to process.cwd() will return the
					// expected cwd instead of the true cwd.
					edgioCwd = directory;
					return;
				}
				originalChdir(directory);
			};
			// @ts-ignore
			process.chdir.__edgio_runner_override = true;
		}

		const originalCwd = process.cwd;
		if (!process.cwd.hasOwnProperty('__edgio_runner_override')) {
			process.cwd = () => {
				const stack = new Error().stack;

				const cwdLines =
					stack?.split('\n').filter((line) => line.includes('process.cwd') || line.includes(edgioPathName)) ?? [];

				// This implies cwd() was called from within the Edgio handler.
				if (cwdLines.length >= 2 && edgioCwd) {
					logger.info(`${extensionPrefix} cwd: Returning edgioCwd: ${edgioCwd}`);
					return edgioCwd;
				}

				return originalCwd();
			};
			// @ts-ignore
			process.cwd.__edgio_runner_override = true;
		}

		const production = true;
		const edgioDir = join(cwd, '.edgio');
		const assetsDir = join(edgioDir, 's3');
		const permanentAssetsDir = join(edgioDir, 's3-permanent');
		const staticAssetDirs = [assetsDir, permanentAssetsDir];
		const withHandler = false;

		await serveStaticAssets(staticAssetDirs, serverInstance.ports.assetPort);
		await runWithServerless(edgioDir, { devMode: !production, withHandler });
		await waitForServerReady();

		// Start the Edgio server
		logger.info(
			`${extensionPrefix} Edgio server ready on http://${serverInstance.ports.localhost}:${serverInstance.ports.port} after ${performance.now() - timerStart}ms (pid: ${process.pid})`
		);

		// Release the lock and exit
		unlinkSync(edgioLockPath);
		break;
	}

	if (attempt >= maxAttempts) {
		logger.error(`${extensionPrefix} Max attempts reached. Could not prepare Edgio server.`);
	}
}
