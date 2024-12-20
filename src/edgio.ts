import { join } from 'node:path';
import http from 'node:http';
import net from 'node:net';

let serveStaticAssets: any;
let runWithServerless: any;
let edgioPorts: any;

try {
	const corePath = require.resolve('@edgio/cli/constants/core.js');
	const serveStaticAssetsPath = require.resolve('@edgio/cli/serverless/serveStaticAssets.js');
	const runWithServerlessPath = require.resolve('@edgio/cli/utils/runWithServerless.js');
	serveStaticAssets = await import(serveStaticAssetsPath).then((mod) => mod.default);
	runWithServerless = await import(runWithServerlessPath).then((mod) => mod.default);
	const edgioCore = await import(corePath);
	edgioPorts = edgioCore.PORTS;
} catch (error) {
	console.error(`Failed to resolve or import serveStaticAssets or runWithServerless: ${error}`);
}

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
const assetPort = 3002;
const staticAssetDirs = [assetsDir, permanentAssetsDir];
const withHandler = false;

const startEdgio = async () => {
	const readyPromise = checkServerReady();
	await serveStaticAssets(staticAssetDirs, assetPort);
	await runWithServerless(edgioDir, { devMode: !production, withHandler });
	return readyPromise;
};

export async function checkServerReady(): Promise<{ host: string; port: number }> {
	const { localhost, port } = edgioPorts;

	return new Promise((resolve, reject) => {
		const timeout = 5000;
		const startTime = Date.now();

		const checkPort = () => {
			const socket = new net.Socket();

			socket
				.once('connect', () => {
					socket.destroy();
					resolve({ host: localhost, port });
				})
				.once('error', () => {
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

export async function handleEdgioRequest(req: any, res: any): Promise<any> {
	const { host, port } = await checkServerReady();

	const options = {
		method: req.method,
		headers: req.headers,
		hostname: host,
		port: port,
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

export default startEdgio;
