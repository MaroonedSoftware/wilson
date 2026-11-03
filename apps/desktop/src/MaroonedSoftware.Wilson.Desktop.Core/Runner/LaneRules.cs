using System.Text.Json;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.Core.Runner;

/// <summary>A lane's settings box as read: what would change, or why it cannot be read.</summary>
public sealed record LaneSettingsDraft(JsonElement? Patch, string? Problem);

/// <summary>What editing a lane decides. The server checks the values: nothing here knows which settings exist.</summary>
public static class LaneRules
{
    private static readonly JsonSerializerOptions Indented = new() { WriteIndented = true };

    /// <summary>The parts of a lane this page only shows.</summary>
    public static string Summary(Lane lane)
    {
        ArgumentNullException.ThrowIfNull(lane);

        return $"{Word(lane.Mode)}, worktree {Word(lane.Worktree)}, passes to {lane.OnPass}, fails to {lane.OnFail}";
    }

    /// <summary>A lane's settings as the box shows them.</summary>
    public static string SettingsText(JsonElement settings) => JsonSerializer.Serialize(settings, Indented);

    /// <summary>
    /// The box against what is stored, as the API patches it: a key set is sent, a key gone is sent as
    /// null, and anything unchanged is left out, so an edit elsewhere to another key survives this one.
    /// An empty box is no settings at all, which puts every one back to its default.
    /// </summary>
    public static LaneSettingsDraft ReadSettings(JsonElement stored, string? draft)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(string.IsNullOrWhiteSpace(draft) ? "{}" : draft);
        }
        catch (JsonException failure)
        {
            return new LaneSettingsDraft(null, $"Not valid JSON: {failure.Message}");
        }

        using (document)
        {
            if (document.RootElement.ValueKind != JsonValueKind.Object)
            {
                return new LaneSettingsDraft(null, "Settings must be a JSON object.");
            }

            return new LaneSettingsDraft(Changes(stored, document.RootElement), null);
        }
    }

    /// <summary>What saving would send, or none when nothing would change.</summary>
    public static PatchLaneRequest? Patch(Lane stored, string? instructions, JsonElement? settings)
    {
        ArgumentNullException.ThrowIfNull(stored);

        var changed = instructions ?? string.Empty;
        return changed == stored.Instructions && settings is null
            ? null
            : new PatchLaneRequest { Instructions = changed == stored.Instructions ? null : changed, Settings = settings };
    }

    private static JsonElement? Changes(JsonElement stored, JsonElement draft)
    {
        var before = stored.ValueKind == JsonValueKind.Object ? stored.EnumerateObject().ToDictionary(key => key.Name, key => key.Value) : [];
        var after = new Dictionary<string, JsonElement>();
        foreach (var key in draft.EnumerateObject())
        {
            after[key.Name] = key.Value;
        }

        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            foreach (var (name, value) in after)
            {
                var kept = before.TryGetValue(name, out var old);
                if (value.ValueKind == JsonValueKind.Null ? kept : !kept || !JsonElement.DeepEquals(old, value))
                {
                    writer.WritePropertyName(name);
                    value.WriteTo(writer);
                }
            }

            foreach (var name in before.Keys.Where(name => !after.ContainsKey(name)))
            {
                writer.WriteNull(name);
            }

            writer.WriteEndObject();
        }

        using var changes = JsonDocument.Parse(buffer.ToArray());
        return changes.RootElement.EnumerateObject().Any() ? changes.RootElement.Clone() : null;
    }

    private static string Word<T>(T value)
        where T : struct, Enum => value.ToString().ToLowerInvariant();
}
