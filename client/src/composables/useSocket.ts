import { ref, onUnmounted } from 'vue';
import { io, Socket } from 'socket.io-client';
import type { ServerToClientEvents, ClientToServerEvents } from '@uptime-detective/shared';

let socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;

export function useSocket() {
  const connected = ref(false);

  function connect(): Socket<ServerToClientEvents, ClientToServerEvents> {
    if (socket?.connected) return socket;

    const url = import.meta.env.PROD ? window.location.origin : 'http://localhost:3300';
    socket = io(url, { transports: ['websocket', 'polling'] });

    socket.on('connect', () => {
      connected.value = true;
    });

    socket.on('disconnect', () => {
      connected.value = false;
    });

    return socket;
  }

  function disconnect(): void {
    if (socket) {
      socket.disconnect();
      socket = null;
      connected.value = false;
    }
  }

  function getSocket(): Socket<ServerToClientEvents, ClientToServerEvents> {
    if (!socket) return connect();
    return socket;
  }

  return { connected, connect, disconnect, getSocket };
}
