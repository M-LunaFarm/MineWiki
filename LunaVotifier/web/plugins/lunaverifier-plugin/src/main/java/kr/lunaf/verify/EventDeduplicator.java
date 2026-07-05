package kr.lunaf.verify;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.lang.reflect.Type;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public class EventDeduplicator {
  private final Gson gson = new Gson();
  private final Map<String, Long> seen = new ConcurrentHashMap<>();
  private final File file;
  private final long ttlMillis;

  public EventDeduplicator(File file, long ttlSeconds) {
    this.file = file;
    this.ttlMillis = ttlSeconds <= 0 ? 0 : ttlSeconds * 1000L;
  }

  public synchronized void load() {
    if (file == null || !file.exists()) {
      return;
    }
    try (FileReader reader = new FileReader(file)) {
      final Type type = new TypeToken<Map<String, Long>>() {}.getType();
      final Map<String, Long> loaded = gson.fromJson(reader, type);
      if (loaded != null) {
        seen.putAll(loaded);
      }
      prune();
    } catch (Exception err) {
      // ignore
    }
  }

  public synchronized void save() {
    if (file == null) {
      return;
    }
    try {
      file.getParentFile().mkdirs();
      try (FileWriter writer = new FileWriter(file)) {
        gson.toJson(seen, writer);
      }
    } catch (Exception err) {
      // ignore
    }
  }

  public synchronized boolean markIfNew(String eventId) {
    if (eventId == null || eventId.isEmpty()) {
      return false;
    }
    prune();
    if (seen.containsKey(eventId)) {
      return false;
    }
    seen.put(eventId, System.currentTimeMillis());
    save();
    return true;
  }

  private synchronized void prune() {
    if (ttlMillis <= 0) {
      return;
    }
    final long cutoff = System.currentTimeMillis() - ttlMillis;
    seen.entrySet().removeIf(entry -> entry.getValue() < cutoff);
  }
}
