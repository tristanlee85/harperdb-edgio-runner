import { join } from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { setTimeout } from 'node:timers/promises';

export type EdgioServerInstance = {
	ports: {
		localhost: string;
		port: number;
		jsPort: number;
		assetPort: number;
	};
	ready: boolean;
};

export function createServerReadyHandler(): {
	waitForServerReady: () => Promise<EdgioServerInstance | void>;
	isServerReady: () => boolean;
} {
	let serverReadyPromise: Promise<EdgioServerInstance> | null = null;

	return {
		waitForServerReady: function (): Promise<EdgioServerInstance | void> {
			if (serverReadyPromise) {
				return serverReadyPromise;
			}

			serverReadyPromise = new Promise((resolve, reject) => {
				const serverInstance = getServerInstance();
				if (!serverInstance) {
					reject(new Error('Server instance is not set'));
					return;
				}
				const { localhost: host, port } = serverInstance.ports;

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
							checkPort();
						});

					socket.connect(port, host);
				};
				checkPort();
			});

			const timeoutPromise = setTimeout(5000).then(() => {
				throw new Error('Edgio server did not become ready within 5000ms.');
			});

			return Promise.race([serverReadyPromise, timeoutPromise]);
		},
		isServerReady: function (): boolean {
			const serverInstance = getServerInstance();
			return serverInstance?.ready ?? false;
		},
	};
}

export async function handleEdgioRequest(req: any, res: any): Promise<any> {
	const serverInstance = getServerInstance();
	if (!serverInstance) {
		throw new Error('Unable to handle Edgio request because server instance is not set.');
	}
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

export function getServerInstance(): EdgioServerInstance | null {
	if (!process.env.EDGIO_SERVER) {
		return null;
	}
	return JSON.parse(process.env.EDGIO_SERVER);
}

export function setServerInstance(serverInstance: EdgioServerInstance) {
	process.env.EDGIO_SERVER = JSON.stringify(serverInstance);
}
