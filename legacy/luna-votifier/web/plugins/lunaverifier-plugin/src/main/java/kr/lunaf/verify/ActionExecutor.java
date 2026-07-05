package kr.lunaf.verify;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.bukkit.entity.Player;
import org.bukkit.Bukkit;
import org.bukkit.configuration.file.FileConfiguration;
import org.bukkit.plugin.java.JavaPlugin;

public class ActionExecutor {
  private final JavaPlugin plugin;
  private final Gson gson = new Gson();
  private final boolean enableHttpActions;
  private final boolean logUnknownActions;
  private final Set<String> httpAllowlist;
  private final int httpTimeoutSeconds;
  private final boolean logHttpResponse;
  private final int logHttpResponseMax;
  private final Set<String> httpAllowedSchemes;
  private final Set<Integer> httpAllowedPorts;
  private final HttpClient httpClient;
  private final ExecutorService httpExecutor;

  public ActionExecutor(JavaPlugin plugin, FileConfiguration config) {
    this.plugin = plugin;
    this.enableHttpActions = config.getBoolean("enable-http-actions", false);
    this.logUnknownActions = config.getBoolean("log-unknown-actions", true);
    this.httpAllowlist = new HashSet<>();
    if (config.isList("http-allowlist")) {
      for (Object item : config.getList("http-allowlist")) {
        if (item != null) {
          httpAllowlist.add(String.valueOf(item).toLowerCase(Locale.ROOT));
        }
      }
    }
    this.httpTimeoutSeconds = Math.max(1, config.getInt("http-timeout-seconds", 5));
    this.logHttpResponse = config.getBoolean("http-log-response", false);
    this.logHttpResponseMax = Math.max(100, config.getInt("http-log-response-max", 500));
    this.httpAllowedSchemes = new HashSet<>();
    if (config.isList("http-allowed-schemes")) {
      for (Object item : config.getList("http-allowed-schemes")) {
        if (item != null) {
          final String scheme = String.valueOf(item).trim().toLowerCase(Locale.ROOT);
          if (!scheme.isEmpty()) {
            httpAllowedSchemes.add(scheme);
          }
        }
      }
    }
    if (httpAllowedSchemes.isEmpty()) {
      httpAllowedSchemes.add("http");
      httpAllowedSchemes.add("https");
    }
    this.httpAllowedPorts = new HashSet<>();
    if (config.isList("http-allowed-ports")) {
      for (Object item : config.getList("http-allowed-ports")) {
        if (item != null) {
          try {
            int port = Integer.parseInt(String.valueOf(item).trim());
            if (port > 0) {
              httpAllowedPorts.add(port);
            }
          } catch (NumberFormatException err) {
            // ignore
          }
        }
      }
    }
    if (httpAllowedPorts.isEmpty()) {
      httpAllowedPorts.add(80);
      httpAllowedPorts.add(443);
    }
    this.httpClient = HttpClient.newBuilder()
      .connectTimeout(Duration.ofSeconds(3))
      .build();
    this.httpExecutor = Executors.newFixedThreadPool(2, runnable -> {
      Thread thread = new Thread(runnable);
      thread.setName("lunavotifier-http");
      thread.setDaemon(true);
      return thread;
    });
  }

  public void execute(JsonArray actions, TokenReplacer tokens, String eventType) {
    if (actions == null || actions.isEmpty()) {
      return;
    }
    for (JsonElement element : actions) {
      if (!element.isJsonObject()) {
        continue;
      }
      final JsonObject action = element.getAsJsonObject();
      final String type = getString(action, "type");
      if (type == null) {
        continue;
      }
      switch (type) {
        case "console_command":
          executeConsoleCommand(action, tokens);
          break;
        case "server_command":
          executeConsoleCommand(action, tokens);
          break;
        case "player_command":
          executePlayerCommand(action, tokens);
          break;
        case "player_message":
          executePlayerMessage(action, tokens);
          break;
        case "broadcast":
          executeBroadcast(action, tokens);
          break;
        case "http_request":
          executeHttpRequest(action, tokens, eventType);
          break;
        default:
          if (logUnknownActions) {
            plugin.getLogger().warning("Unknown action type: " + type);
          }
          break;
      }
    }
  }

  public void shutdown() {
    httpExecutor.shutdownNow();
  }

  private void executeConsoleCommand(JsonObject action, TokenReplacer tokens) {
    String command = getString(action, "command");
    if (command == null || command.isBlank()) {
      return;
    }
    command = tokens.apply(command).trim();
    if (command.startsWith("/")) {
      command = command.substring(1);
    }
    final String finalCommand = command;
    if (finalCommand.isEmpty()) {
      return;
    }
    Bukkit.getScheduler().runTask(plugin, () -> {
      Bukkit.dispatchCommand(Bukkit.getConsoleSender(), finalCommand);
    });
  }

  private void executePlayerCommand(JsonObject action, TokenReplacer tokens) {
    String command = getString(action, "command");
    if (command == null || command.isBlank()) {
      return;
    }
    String playerName = getString(action, "player");
    if (playerName == null || playerName.isBlank()) {
      playerName = tokens.apply("%player%");
    } else {
      playerName = tokens.apply(playerName);
    }
    if (playerName == null || playerName.isBlank()) {
      plugin.getLogger().warning("player_command missing player");
      return;
    }
    command = tokens.apply(command).trim();
    if (command.startsWith("/")) {
      command = command.substring(1);
    }
    final String finalCommand = command;
    final String targetName = playerName.trim();
    if (finalCommand.isEmpty()) {
      return;
    }
    Bukkit.getScheduler().runTask(plugin, () -> {
      Player player = Bukkit.getPlayerExact(targetName);
      if (player == null) {
        plugin.getLogger().warning("player_command target offline: " + targetName);
        return;
      }
      player.performCommand(finalCommand);
    });
  }

  private void executePlayerMessage(JsonObject action, TokenReplacer tokens) {
    String message = getString(action, "message");
    if (message == null || message.isBlank()) {
      message = getString(action, "content");
    }
    if (message == null || message.isBlank()) {
      return;
    }
    String playerName = getString(action, "player");
    if (playerName == null || playerName.isBlank()) {
      playerName = tokens.apply("%player%");
    } else {
      playerName = tokens.apply(playerName);
    }
    if (playerName == null || playerName.isBlank()) {
      plugin.getLogger().warning("player_message missing player");
      return;
    }
    final String finalMessage = tokens.apply(message);
    final String targetName = playerName.trim();
    Bukkit.getScheduler().runTask(plugin, () -> {
      Player player = Bukkit.getPlayerExact(targetName);
      if (player == null) {
        plugin.getLogger().warning("player_message target offline: " + targetName);
        return;
      }
      player.sendMessage(finalMessage);
    });
  }

  private void executeBroadcast(JsonObject action, TokenReplacer tokens) {
    String message = getString(action, "message");
    if (message == null || message.isBlank()) {
      message = getString(action, "content");
    }
    if (message == null || message.isBlank()) {
      return;
    }
    final String finalMessage = tokens.apply(message);
    Bukkit.getScheduler().runTask(plugin, () -> Bukkit.broadcastMessage(finalMessage));
  }

  private void executeHttpRequest(JsonObject action, TokenReplacer tokens, String eventType) {
    if (!enableHttpActions) {
      plugin.getLogger().warning("http_request is disabled. Event: " + eventType);
      return;
    }

    String url = getString(action, "url");
    if (url == null || url.isBlank()) {
      return;
    }
    url = tokens.apply(url).trim();

    final URI uri;
    try {
      uri = new URI(url);
    } catch (URISyntaxException err) {
      plugin.getLogger().warning("Invalid http_request url: " + url);
      return;
    }

    final String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
    if (!isAllowedScheme(scheme)) {
      plugin.getLogger().warning("Blocked http_request scheme: " + scheme);
      return;
    }
    int port = uri.getPort();
    if (port == -1) {
      port = defaultPortForScheme(scheme);
    }
    if (!isAllowedPort(port)) {
      plugin.getLogger().warning("Blocked http_request port: " + port);
      return;
    }

    final String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
    if (!isAllowedHost(host)) {
      plugin.getLogger().warning("Blocked http_request host: " + host);
      return;
    }

    String method = getString(action, "method");
    method = method == null || method.isBlank() ? "POST" : method.toUpperCase(Locale.ROOT);

    JsonElement bodyElement = action.get("body");
    String bodyText = null;
    if (bodyElement != null && !bodyElement.isJsonNull()) {
      final JsonElement rendered = tokens.apply(bodyElement);
      bodyText = rendered.isJsonPrimitive() && rendered.getAsJsonPrimitive().isString()
        ? rendered.getAsString()
        : gson.toJson(rendered);
    }

    int timeoutMs = getInt(action, "timeout_ms");
    int timeoutSeconds = getInt(action, "timeout_seconds");
    Duration timeout = Duration.ofSeconds(httpTimeoutSeconds);
    if (timeoutMs > 0) {
      timeout = Duration.ofMillis(timeoutMs);
    } else if (timeoutSeconds > 0) {
      timeout = Duration.ofSeconds(timeoutSeconds);
    }

    HttpRequest.Builder builder = HttpRequest.newBuilder()
      .uri(uri)
      .timeout(timeout);

    boolean hasContentType = false;
    if (action.has("headers") && action.get("headers").isJsonObject()) {
      for (java.util.Map.Entry<String, JsonElement> entry : action.getAsJsonObject("headers").entrySet()) {
        final String headerName = entry.getKey();
        if (headerName == null) {
          continue;
        }
        String headerValue = "";
        if (!entry.getValue().isJsonNull()) {
          if (entry.getValue().isJsonPrimitive()) {
            headerValue = tokens.apply(entry.getValue().getAsString());
          } else {
            headerValue = tokens.apply(entry.getValue().toString());
          }
        }
        builder.header(headerName, headerValue);
        if ("content-type".equalsIgnoreCase(headerName)) {
          hasContentType = true;
        }
      }
    }

    if (bodyText != null) {
      if (!hasContentType) {
        builder.header("Content-Type", "application/json");
      }
      builder.method(method, HttpRequest.BodyPublishers.ofString(bodyText));
    } else {
      builder.method(method, HttpRequest.BodyPublishers.noBody());
    }

    final boolean shouldLogResponse = getBoolean(action, "log_response", logHttpResponse);
    httpExecutor.submit(() -> {
      try {
        HttpResponse<String> response = httpClient.send(builder.build(), HttpResponse.BodyHandlers.ofString());
        if (shouldLogResponse) {
          String body = response.body();
          if (body == null) {
            body = "";
          }
          if (body.length() > logHttpResponseMax) {
            body = body.substring(0, logHttpResponseMax) + "...";
          }
          plugin.getLogger().info("http_request response " + response.statusCode() + " " + uri + " body=" + body);
        }
      } catch (Exception err) {
        plugin.getLogger().warning("http_request failed: " + err.getMessage());
      }
    });
  }

  private boolean isAllowedHost(String host) {
    if (host == null || host.isBlank()) {
      return false;
    }
    if (httpAllowlist.isEmpty()) {
      return false;
    }
    if (httpAllowlist.contains(host)) {
      return true;
    }
    for (String allowed : httpAllowlist) {
      if (allowed.startsWith("*.") && host.endsWith(allowed.substring(1))) {
        return true;
      }
    }
    return false;
  }

  private boolean isAllowedScheme(String scheme) {
    if (scheme == null || scheme.isBlank()) {
      return false;
    }
    return httpAllowedSchemes.contains(scheme.toLowerCase(Locale.ROOT));
  }

  private int defaultPortForScheme(String scheme) {
    if (scheme == null) {
      return -1;
    }
    if ("http".equalsIgnoreCase(scheme)) {
      return 80;
    }
    if ("https".equalsIgnoreCase(scheme)) {
      return 443;
    }
    return -1;
  }

  private boolean isAllowedPort(int port) {
    if (port <= 0) {
      return false;
    }
    return httpAllowedPorts.contains(port);
  }

  private static String getString(JsonObject obj, String key) {
    if (obj == null || key == null || !obj.has(key) || obj.get(key).isJsonNull()) {
      return null;
    }
    try {
      return obj.get(key).getAsString();
    } catch (Exception err) {
      return null;
    }
  }

  private static int getInt(JsonObject obj, String key) {
    if (obj == null || key == null || !obj.has(key) || obj.get(key).isJsonNull()) {
      return 0;
    }
    try {
      return obj.get(key).getAsInt();
    } catch (Exception err) {
      return 0;
    }
  }

  private static boolean getBoolean(JsonObject obj, String key, boolean fallback) {
    if (obj == null || key == null || !obj.has(key) || obj.get(key).isJsonNull()) {
      return fallback;
    }
    try {
      return obj.get(key).getAsBoolean();
    } catch (Exception err) {
      return fallback;
    }
  }
}
