import { join } from 'node:path';
import http from 'node:http';
import net from 'node:net';

export type EdgioServerInstance = {
	ports: {
		localhost: string;
		port: number;
		jsPort: number;
		assetPort: number;
	};
	ready: boolean;
};

if (!process.env.EDGIO_SERVER) {
	try {
		logger.info('importing edgio modules');
		// Load the Edgio ports into the shared process.env for all workers to reference.
		// This is necessary because servers such as Next.js will set process.env.PORT AFTER
		// the Edgio server has started. This is problematic because if `@edgio/cli/constants/core.js`
		// is re-imported within a worker thread, then `edgioCore.PORTS.port` will become what
		// Next.js sets it to (e.g. 3001), rather than the default Edgio server's port (e.g. 3000).

		// const edgioCore = await import('@edgio/cli/constants/core.js');
		const serverInstance: EdgioServerInstance = {
			ports: {
				localhost: 'localhost',
				port: 3000,
				jsPort: 3001,
				assetPort: 3002,
			},
			ready: false,
		};
		process.env.EDGIO_SERVER = JSON.stringify(serverInstance);
	} catch (error) {
		logger.error(`Failed to resolve or import serveStaticAssets or runWithServerless: ${error}`);
	}
}

const serverInstance: EdgioServerInstance = JSON.parse(process.env.EDGIO_SERVER!);

const cwd = process.cwd();
const edgioPathName = '.edgio/';
let edgioCwd: string | undefined;

// Edgio will attempt to change the cwd to .edgio/lambda/, but this is not permissible
// within worker threads. This invocation of process.chdir() becomes a no-op within
// that context.
const originalChdir = process.chdir;
// This check is to avoid re-overriding process.cwd() in worker threads.
if (!process.chdir.hasOwnProperty('__edgio_runner_override')) {
	process.chdir = (directory) => {
		if (directory.includes(edgioPathName)) {
			// Edgio has attempted to change the cwd so future calls to process.cwd() will return the
			// new cwd.
			edgioCwd = directory;
			return;
		}
		originalChdir(directory);
	};
	// @ts-ignore
	process.chdir.__edgio_runner_override = true;
}

const originalCwd = process.cwd;
// This check is to avoid re-overriding process.cwd() in worker threads.
if (!process.cwd.hasOwnProperty('__edgio_runner_override')) {
	process.cwd = () => {
		const stack = new Error().stack;

		const cwdLines =
			stack?.split('\n').filter((line) => line.includes('process.cwd') || line.includes(edgioPathName)) ?? [];

		// This implies cwd() was called from within the Edgio handler.
		if (cwdLines.length >= 2 && edgioCwd) {
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

logger.info(`- serverInstance: ${JSON.stringify(serverInstance, null, 2)}`);
logger.info(`- edgioDir: ${edgioDir}`);

const startEdgio = async () => {
	console.log('serverInstance', serverInstance);
	console.log('edgioDir', edgioDir);
	const readyPromise = checkServerReady();

	// const serveStaticAssets = (await import('@edgio/cli/serverless/serveStaticAssets.js')).default;
	// const runWithServerless = (await import('@edgio/cli/utils/runWithServerless.js')).default;

	// await serveStaticAssets(staticAssetDirs, serverInstance.ports.assetPort);
	// await runWithServerless(edgioDir, { devMode: !production, withHandler });
	return readyPromise;
};

export async function checkServerReady(): Promise<EdgioServerInstance> {
	const { localhost: host, port } = serverInstance.ports;

	return new Promise((resolve, reject) => {
		const timeout = 5000;
		const startTime = Date.now();

		const checkPort = () => {
			const socket = new net.Socket();

			socket
				.once('connect', () => {
					socket.destroy();
					serverInstance.ready = true;
					process.env.EDGIO_SERVER = JSON.stringify(serverInstance);
					resolve(serverInstance);
				})
				.once('error', () => {
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

export async function handleEdgioRequest(req: any, res: any): Promise<any> {
	const serverInstance = getServerInstance();
	const { localhost: host, port } = serverInstance.ports;
	const options = {
		method: req.method,
		headers: req.headers,
		hostname: host,
		port,
		path: req.url,
	};

	const proxy = http.request(options, (proxyRes: any) => {
		res.writeHead(proxyRes.statusCode, proxyRes.headers);
		proxyRes.pipe(res, { end: true });
	});

	req.pipe(proxy, { end: true });

	return new Promise((resolve, reject) => {
		proxy.on('error', (err: any) => {
			reject(err);
		});

		proxy.on('finish', () => {
			resolve(res);
		});
	});
}

export function getServerInstance(): EdgioServerInstance {
	return JSON.parse(process.env.EDGIO_SERVER!);
}

export default startEdgio;
