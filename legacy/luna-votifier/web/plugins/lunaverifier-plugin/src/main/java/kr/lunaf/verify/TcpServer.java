package kr.lunaf.verify;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

public class TcpServer {
  private final LunaVotifierPlugin plugin;
  private final int port;
  private final ExecutorService acceptExecutor;
  private final ThreadPoolExecutor clientExecutor;
  private volatile boolean running;
  private ServerSocket serverSocket;

  public TcpServer(
    LunaVotifierPlugin plugin,
    int port,
    int maxClientThreads,
    int queueSize
  ) {
    this.plugin = plugin;
    this.port = port;
    this.acceptExecutor = Executors.newSingleThreadExecutor(new NamedThreadFactory("lunavotifier-accept"));
    final int safeThreads = Math.max(1, maxClientThreads);
    final int safeQueue = Math.max(1, queueSize);
    this.clientExecutor = new ThreadPoolExecutor(
      safeThreads,
      safeThreads,
      0L,
      TimeUnit.MILLISECONDS,
      new ArrayBlockingQueue<>(safeQueue),
      new NamedThreadFactory("lunavotifier-client"),
      new ThreadPoolExecutor.AbortPolicy()
    );
  }

  public void start() throws IOException {
    serverSocket = new ServerSocket(port);
    running = true;
    acceptExecutor.submit(this::acceptLoop);
  }

  private void acceptLoop() {
    while (running) {
      try {
        final Socket socket = serverSocket.accept();
        try {
          clientExecutor.submit(() -> handleClient(socket));
        } catch (RejectedExecutionException err) {
          plugin.getLogger().warning("TCP client queue full; dropping connection.");
          closeQuietly(socket);
        }
      } catch (SocketException err) {
        if (running) {
          plugin.getLogger().warning("TCP accept error: " + err.getMessage());
        }
      } catch (IOException err) {
        plugin.getLogger().warning("TCP accept IO error: " + err.getMessage());
      }
    }
  }

  private void handleClient(Socket socket) {
    try (Socket client = socket;
      BufferedReader reader = new BufferedReader(new InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8));
      BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(client.getOutputStream(), StandardCharsets.UTF_8))) {
      client.setSoTimeout(5000);
      final String line = reader.readLine();
      if (line == null) {
        return;
      }
      final String response = plugin.handlePacket(line);
      if (response != null && !response.isEmpty()) {
        writer.write(response);
        writer.newLine();
        writer.flush();
      }
    } catch (Exception err) {
      plugin.getLogger().warning("TCP client error: " + err.getMessage());
    }
  }

  public void close() {
    running = false;
    if (serverSocket != null) {
      try {
        serverSocket.close();
      } catch (IOException err) {
        plugin.getLogger().warning("Failed to close TCP server: " + err.getMessage());
      }
    }
    acceptExecutor.shutdownNow();
    clientExecutor.shutdownNow();
  }

  private static void closeQuietly(Socket socket) {
    if (socket == null) {
      return;
    }
    try {
      socket.close();
    } catch (IOException err) {
      // ignore
    }
  }

  private static class NamedThreadFactory implements ThreadFactory {
    private final String baseName;
    private final AtomicInteger counter = new AtomicInteger(1);

    private NamedThreadFactory(String baseName) {
      this.baseName = baseName;
    }

    @Override
    public Thread newThread(Runnable task) {
      final Thread thread = new Thread(task);
      thread.setName(baseName + "-" + counter.getAndIncrement());
      thread.setDaemon(true);
      return thread;
    }
  }
}
