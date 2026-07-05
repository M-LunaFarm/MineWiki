package kr.lunaf.verify;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import java.util.HashMap;
import java.util.Map;

public class TokenReplacer {
  private final Map<String, String> tokens;

  public TokenReplacer(Map<String, String> tokens) {
    this.tokens = new HashMap<>();
    if (tokens != null) {
      tokens.forEach((key, value) -> this.tokens.put(key, value == null ? "" : value));
    }
  }

  public String apply(String input) {
    if (input == null) {
      return null;
    }
    String result = input;
    for (Map.Entry<String, String> entry : tokens.entrySet()) {
      final String key = entry.getKey();
      final String value = entry.getValue();
      if (key == null || key.isEmpty()) {
        continue;
      }
      result = result.replace("%" + key + "%", value);
    }
    return result;
  }

  public JsonElement apply(JsonElement element) {
    if (element == null || element.isJsonNull()) {
      return element;
    }
    if (element.isJsonPrimitive()) {
      final JsonPrimitive primitive = element.getAsJsonPrimitive();
      if (primitive.isString()) {
        return new JsonPrimitive(apply(primitive.getAsString()));
      }
      return primitive;
    }
    if (element.isJsonArray()) {
      final JsonArray array = new JsonArray();
      for (JsonElement item : element.getAsJsonArray()) {
        array.add(apply(item));
      }
      return array;
    }
    if (element.isJsonObject()) {
      final JsonObject object = new JsonObject();
      for (Map.Entry<String, JsonElement> entry : element.getAsJsonObject().entrySet()) {
        object.add(entry.getKey(), apply(entry.getValue()));
      }
      return object;
    }
    return element;
  }
}
