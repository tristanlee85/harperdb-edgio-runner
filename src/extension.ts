import assert from 'node:assert';
import { openSync, writeSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { threadId } from 'node:worker_threads';
import { handleEdgioRequest, createServerReadyHandler, getServerInstance, setServerInstance } from './edgio';
import type { EdgioServerInstance } from './edgio';

const extensionPrefix = '[edgio-runner]';
const edgioLockPath = join(tmpdir(), '.edgio-server.lock');

const _info = (message: string) => {
	logger.error(`INFO ${extensionPrefix} ${message} (pid: ${process.pid}, threadId: ${threadId})`);
};

const _error = (message: string) => {
	logger.error(`ERROR ${extensionPrefix} ${message} (pid: ${process.pid}, threadId: ${threadId})`);
};

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

// export function startOnMainThread(options: ExtensionOptions) {
// 	return {
// 		async setupDirectory(_: any, componentPath: string) {
// 			console.log('setupDirectory', componentPath);
// 			unlinkSync(edgioLockPath);
// 		},
// 	};
// }

export function start(options: ExtensionOptions) {
	const config = resolveConfig(options);

	return {
		async handleDirectory(_: any, componentPath: string) {
			_info('start:handleDirectory');
			await prepareServer(config, componentPath, options.server);

			options.server.http(async (request: any, nextHandler: any) => {
				const { _nodeRequest: req, _nodeResponse: res } = request;

				_info(`Handling request: ${req.url.split('?')[0]}`);

				await handleEdgioRequest(req, res);

				_info(`Finished handling request: ${req.url.split('?')[0]}`);

				nextHandler(request);
			});

			return true;
		},
	};
}

async function prepareServer(config: any, componentPath: string, server: any) {
	const { isServerReady } = createServerReadyHandler();
	const maxAttempts = 20;
	const lockTimeout = 5000;
	const checkInterval = 250;
	let attempt = 0;

	const startTime = Date.now();

	while (attempt < maxAttempts) {
		const elapsedTime = Date.now() - startTime;

		if (elapsedTime > lockTimeout) {
			throw new Error('Timeout while waiting for the server lock.');
		}

		if (isServerReady()) {
			_info('Server is already running. Exiting lock acquisition loop.');
			return;
		}

		try {
			const lockFileHandle = openSync(edgioLockPath, 'wx');
			writeSync(lockFileHandle, process.pid.toString());

			_info('Lock file acquired. Starting the server.');

			try {
				await startEdgioServer(componentPath);
			} finally {
				unlinkSync(edgioLockPath);
				_info('Lock file released.');
			}

			return;
		} catch (err: any) {
			if (err.code === 'EEXIST') {
				_error(`Lock file exists. Waiting for release... (Attempt ${attempt + 1})`);
				await setTimeout(checkInterval);
				attempt++;
				continue;
			}
			throw err;
		}
	}

	// At this point, we assume the lock should not exist and remove it to
	// avoid future lock acquisition issues.
	unlinkSync(edgioLockPath);
	throw new Error('Max attempts reached. Could not acquire the server lock.');
}

async function startEdgioServer(componentPath: string) {
	const { waitForServerReady } = createServerReadyHandler();
	_info('Preparing Edgio server');

	const timerStart = performance.now();
	const componentRequire = createRequire(componentPath);
	const serveStaticAssets = (await import(componentRequire.resolve('@edgio/cli/serverless/serveStaticAssets'))).default;
	const runWithServerless = (await import(componentRequire.resolve('@edgio/cli/utils/runWithServerless'))).default;

	// Load the Edgio ports into the shared process.env for all workers to reference.
	// This is necessary because servers such as Next.js will set process.env.PORT AFTER
	// the Edgio server has started. This is problematic because if `@edgio/cli/constants/core.js`
	// is re-imported within a worker thread, then `edgioCore.PORTS.port` will become what
	// Next.js sets it to (e.g. 3001), rather than the default Edgio server's port (3000).
	let serverInstance: EdgioServerInstance | null = getServerInstance();
	if (!serverInstance) {
		const edgioCore = (await import(componentRequire.resolve('@edgio/cli/constants/core'))).default;
		serverInstance = {
			ports: {
				localhost: edgioCore.PORTS.localhost,
				port: edgioCore.PORTS.port,
				jsPort: edgioCore.PORTS.jsPort,
				assetPort: edgioCore.PORTS.assetPort,
			},
			ready: false,
		};
		setServerInstance(serverInstance);
	}

	const cwd = componentPath;
	const edgioPathName = '.edgio/';
	let edgioCwd: string | undefined;

	// Edgio will attempt to change the cwd to .edgio/lambda/, but this is not permissible
	// within worker threads. This invocation of process.chdir() becomes a no-op within
	// that context.
	const originalChdir = process.chdir;
	if (!process.chdir.hasOwnProperty('__edgio_runner_override')) {
		process.chdir = (directory) => {
			if (directory.includes(edgioPathName)) {
				_info(`chdir: Changing cwd to ${directory}`);
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
			// if (cwdLines.length >= 2 && edgioCwd) {
			// 	_info(`cwd: Returning edgioCwd: ${edgioCwd}`);
			// 	return edgioCwd;
			// }
			if (edgioCwd) {
				_info(`cwd: Returning edgioCwd: ${edgioCwd}`);
				return edgioCwd;
			}

			_info(`cwd: Returning componentPath: ${cwd}`);
			return cwd;
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

	//await serveStaticAssets(staticAssetDirs, serverInstance.ports.assetPort);
	_info(`Running with serverless under ${edgioDir}`);
	_info(
		`Will attempt to resolve 'node_modules/next/dist/server/lib/start-server.js'\nresolve(): ${resolve(
			'node_modules/next/dist/server/lib/start-server.js'
		)}\ncomponentRequire.resolve(): ${componentRequire.resolve.paths('node_modules/next/dist/server/lib/start-server.js')}`
	);
	await runWithServerless(edgioDir, { devMode: !production, withHandler });

	_info('Waiting for server ready');
	await waitForServerReady();

	// Start the Edgio server
	_info(
		`Edgio server ready on http://${serverInstance.ports.localhost}:${serverInstance.ports.port} after ${performance.now() - timerStart}ms`
	);
}
