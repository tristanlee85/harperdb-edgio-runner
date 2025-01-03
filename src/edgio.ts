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

export async function checkServerReady(): Promise<EdgioServerInstance> {
	const serverInstance = getServerInstance();
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
	if (!process.env.EDGIO_SERVER) {
		throw new Error('EDGIO_SERVER is not set');
	}
	return JSON.parse(process.env.EDGIO_SERVER!);
}
