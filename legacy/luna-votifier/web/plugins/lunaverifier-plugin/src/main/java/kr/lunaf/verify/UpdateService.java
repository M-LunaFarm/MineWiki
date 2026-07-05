package kr.lunaf.verify;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Duration;
import java.util.Locale;
import org.bukkit.Bukkit;
import org.bukkit.configuration.file.FileConfiguration;
import org.bukkit.plugin.java.JavaPlugin;

public class UpdateService {
  private final JavaPlugin plugin;
  private final Gson gson = new Gson();
  private final HttpClient client;
  private final boolean enabled;
  private final boolean autoDownload;
  private final String githubOwner;
  private final String githubRepo;
  private final String assetName;
  private final long intervalTicks;
  private final int downloadTimeoutSeconds;
  private int taskId = -1;

  public UpdateService(JavaPlugin plugin, FileConfiguration config) {
    this.plugin = plugin;
    this.enabled = config.getBoolean("update-check-enabled", true);
    this.autoDownload = config.getBoolean("update-auto-download", true);
    this.githubOwner = config.getString("update-github-owner", "").trim();
    this.githubRepo = config.getString("update-github-repo", "").trim();
    this.assetName = config.getString("update-release-asset", "").trim();
    final long intervalSeconds = Math.max(0L, config.getLong("update-check-interval-seconds", 21600L));
    this.intervalTicks = intervalSeconds * 20L;
    this.downloadTimeoutSeconds = Math.max(5, config.getInt("update-download-timeout-seconds", 30));
    this.client = HttpClient.newBuilder()
      .connectTimeout(Duration.ofSeconds(5))
      .build();
  }

  public void start() {
    if (!enabled) {
      return;
    }
    if (githubOwner.isEmpty() || githubRepo.isEmpty()) {
      plugin.getLogger().warning("Update check disabled: update-github-owner/repo not set.");
      return;
    }
    if (intervalTicks <= 0L) {
      taskId = Bukkit.getScheduler().runTaskAsynchronously(plugin, this::checkForUpdates).getTaskId();
    } else {
      taskId = Bukkit.getScheduler().runTaskTimerAsynchronously(plugin, this::checkForUpdates, 0L, intervalTicks).getTaskId();
    }
  }

  public void stop() {
    if (taskId != -1) {
      Bukkit.getScheduler().cancelTask(taskId);
      taskId = -1;
    }
  }

  private void checkForUpdates() {
    try {
      final String currentVersion = normalizeVersion(plugin.getDescription().getVersion());
      final String apiUrl = "https://api.github.com/repos/" + githubOwner + "/" + githubRepo + "/releases/latest";
      final HttpRequest request = HttpRequest.newBuilder()
        .uri(URI.create(apiUrl))
        .timeout(Duration.ofSeconds(10))
        .header("User-Agent", "LunaVerifier/" + currentVersion)
        .header("Accept", "application/vnd.github+json")
        .build();
      final HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
      if (response.statusCode() != 200) {
        plugin.getLogger().warning("Update check failed: HTTP " + response.statusCode());
        return;
      }

      final JsonObject release = JsonParser.parseString(response.body()).getAsJsonObject();
      final String latestTag = normalizeVersion(getString(release, "tag_name"));
      if (latestTag.isEmpty()) {
        plugin.getLogger().warning("Update check failed: missing tag_name.");
        return;
      }

      if (compareVersions(currentVersion, latestTag) >= 0) {
        return;
      }

      final String assetUrl = findAssetUrl(release, assetName);
      final String assetFile = findAssetName(release, assetName);
      if (assetUrl == null || assetFile == null) {
        plugin.getLogger().warning("Update available (" + latestTag + ") but no matching asset found.");
        return;
      }

      plugin.getLogger().info("Update available: " + currentVersion + " -> " + latestTag);
      if (autoDownload) {
        downloadAsset(assetUrl, assetFile);
      }
    } catch (Exception err) {
      plugin.getLogger().warning("Update check error: " + err.getMessage());
    }
  }

  private void downloadAsset(String url, String fileName) {
    try {
      final Path updateDir = plugin.getDataFolder().getParentFile().toPath().resolve("update");
      Files.createDirectories(updateDir);
      final Path target = updateDir.resolve(fileName);
      final HttpRequest request = HttpRequest.newBuilder()
        .uri(URI.create(url))
        .timeout(Duration.ofSeconds(downloadTimeoutSeconds))
        .header("User-Agent", "LunaVerifier/" + plugin.getDescription().getVersion())
        .build();
      final HttpResponse<InputStream> response = client.send(request, HttpResponse.BodyHandlers.ofInputStream());
      if (response.statusCode() != 200) {
        plugin.getLogger().warning("Update download failed: HTTP " + response.statusCode());
        return;
      }
      try (InputStream body = response.body()) {
        Files.copy(body, target, StandardCopyOption.REPLACE_EXISTING);
      }
      plugin.getLogger().info("Update downloaded to " + target + ". Restart server to apply.");
    } catch (Exception err) {
      plugin.getLogger().warning("Update download error: " + err.getMessage());
    }
  }

  private static String findAssetUrl(JsonObject release, String desiredName) {
    final JsonArray assets = release.has("assets") && release.get("assets").isJsonArray()
      ? release.getAsJsonArray("assets")
      : new JsonArray();
    for (int i = 0; i < assets.size(); i++) {
      final JsonObject asset = assets.get(i).getAsJsonObject();
      final String name = getString(asset, "name");
      if (name == null) {
        continue;
      }
      if (!desiredName.isEmpty() && !name.equalsIgnoreCase(desiredName)) {
        continue;
      }
      if (desiredName.isEmpty() && !name.toLowerCase(Locale.ROOT).endsWith(".jar")) {
        continue;
      }
      final String url = getString(asset, "browser_download_url");
      if (url != null && !url.isEmpty()) {
        return url;
      }
    }
    return null;
  }

  private static String findAssetName(JsonObject release, String desiredName) {
    final JsonArray assets = release.has("assets") && release.get("assets").isJsonArray()
      ? release.getAsJsonArray("assets")
      : new JsonArray();
    for (int i = 0; i < assets.size(); i++) {
      final JsonObject asset = assets.get(i).getAsJsonObject();
      final String name = getString(asset, "name");
      if (name == null) {
        continue;
      }
      if (!desiredName.isEmpty() && !name.equalsIgnoreCase(desiredName)) {
        continue;
      }
      if (desiredName.isEmpty() && !name.toLowerCase(Locale.ROOT).endsWith(".jar")) {
        continue;
      }
      return name;
    }
    return null;
  }

  private static String normalizeVersion(String version) {
    if (version == null) {
      return "";
    }
    String trimmed = version.trim();
    if (trimmed.startsWith("v") || trimmed.startsWith("V")) {
      trimmed = trimmed.substring(1);
    }
    return trimmed;
  }

  private static int compareVersions(String current, String latest) {
    final String[] a = current.split("\\.");
    final String[] b = latest.split("\\.");
    final int len = Math.max(a.length, b.length);
    for (int i = 0; i < len; i++) {
      final String pa = i < a.length ? a[i] : "0";
      final String pb = i < b.length ? b[i] : "0";
      final int cmp = compareVersionPart(pa, pb);
      if (cmp != 0) {
        return cmp;
      }
    }
    return 0;
  }

  private static int compareVersionPart(String a, String b) {
    try {
      final int ai = Integer.parseInt(a.replaceAll("[^0-9].*$", ""));
      final int bi = Integer.parseInt(b.replaceAll("[^0-9].*$", ""));
      if (ai != bi) {
        return Integer.compare(ai, bi);
      }
    } catch (NumberFormatException err) {
      // fall back to string compare
    }
    return a.compareToIgnoreCase(b);
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
}
