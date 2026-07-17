import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import type { ServerToClientEvents, ClientToServerEvents } from '@uptime-detective/shared';

let io: Server<ClientToServerEvents, ServerToClientEvents> | null = null;

export function setupSocketIO(httpServer: HttpServer): Server<ClientToServerEvents, ServerToClientEvents> {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.NODE_ENV === 'production' ? false : 'http://localhost:5173',
      credentials: true,
    },
  });

  io.on('connection', (socket: Socket) => {
    console.log(`[socket] Client connected: ${socket.id}`);

    socket.on('subscribe:monitor', (monitorId: number) => {
      socket.join(`monitor:${monitorId}`);
    });

    socket.on('unsubscribe:monitor', (monitorId: number) => {
      socket.leave(`monitor:${monitorId}`);
    });

    socket.on('disconnect', () => {
      console.log(`[socket] Client disconnected: ${socket.id}`);
    });
  });

  return io;
}

export function getIO(): Server<ClientToServerEvents, ServerToClientEvents> {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
}
