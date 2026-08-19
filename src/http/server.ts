export interface HttpServerHandle {
  url: URL;
  stop(closeActiveConnections?: boolean): Promise<void>;
}

export function startHttpServer(
  hostname: string,
  port: number,
  fetchHandler: (request: Request) => Promise<Response>
): HttpServerHandle {
  const server = Bun.serve({ hostname, port, fetch: fetchHandler });
  return {
    url: new URL(`http://${hostname}:${server.port}`),
    async stop(closeActiveConnections = false): Promise<void> {
      await server.stop(closeActiveConnections);
    },
  };
}
