using System.Globalization;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace MaroonedSoftware.Wilson.Desktop.Core.Chat;

/// <summary>How a proposed action's argument is best read.</summary>
public enum ChatFieldKind
{
    /// <summary>A short value, beside its label.</summary>
    Line,

    /// <summary>Longer text, as Markdown.</summary>
    Prose,

    /// <summary>An object or a list, as indented JSON.</summary>
    Json,
}

/// <summary>One argument of a proposed action, as a person reads it.</summary>
public sealed record ChatActionField(string Label, string Value, ChatFieldKind Kind)
{
    public bool IsLine => Kind == ChatFieldKind.Line;

    public bool IsProse => Kind == ChatFieldKind.Prose;

    public bool IsJson => Kind == ChatFieldKind.Json;
}

/// <summary>
/// A proposed action's arguments for the person deciding on it. Every argument is shown, since Confirm
/// runs exactly what is on the card. The same rules as the web app's `lib/chat.arguments.ts`.
/// </summary>
public static partial class ChatArguments
{
    /// <summary>Past this a string is prose even on one line, and would not sit beside its label.</summary>
    private const int LongestLine = 120;

    private const string Body = "body";

    /// <summary>Relaxed, because this is read rather than parsed, and `é` is clearer than `é`.</summary>
    private static readonly JsonSerializerOptions Indented = new()
    {
        WriteIndented = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>
    /// The arguments as fields. A request's `body` wrapper is an API detail and is opened, unless one of
    /// its names is also an argument of its own, when opening it would leave two of one name. Short
    /// values come first: stored arguments are in jsonb's order, which is no order a person would pick,
    /// and a long body would push the rest out of sight.
    /// </summary>
    public static IReadOnlyList<ChatActionField> Fields(JsonElement arguments)
    {
        if (arguments.ValueKind != JsonValueKind.Object)
        {
            return [new ChatActionField("Arguments", Pretty(arguments), ChatFieldKind.Json)];
        }

        return [.. Opened(arguments).Select(Field).OrderBy(field => field.Kind)];
    }

    /// <summary>The arguments exactly as recorded, for when the fields are not enough.</summary>
    public static string Pretty(JsonElement arguments) => JsonSerializer.Serialize(arguments, Indented);

    /// <summary>`webAccess` and `web_access` as `Web access`, and `cardId` as `Card ID`.</summary>
    public static string Label(string name)
    {
        ArgumentNullException.ThrowIfNull(name);

        var words = WordBreak().Replace(name, " ").Split(' ', StringSplitOptions.RemoveEmptyEntries).Select(word => word.ToLowerInvariant()).Select(word => word == "id" ? "ID" : word).ToArray();
        if (words.Length == 0)
        {
            return name;
        }

        words[0] = char.ToUpper(words[0][0], CultureInfo.InvariantCulture) + words[0][1..];
        return string.Join(' ', words);
    }

    private static List<JsonProperty> Opened(JsonElement arguments)
    {
        var properties = arguments.EnumerateObject().ToList();
        var body = properties.FindIndex(property => property.Name == Body);
        if (body == -1 || properties[body].Value.ValueKind != JsonValueKind.Object)
        {
            return properties;
        }

        var inner = properties[body].Value.EnumerateObject().ToList();
        var clashes = inner.Exists(property => properties.Exists(outer => outer.Name == property.Name && outer.Name != Body));
        return clashes ? properties : [.. properties.Take(body), .. inner, .. properties.Skip(body + 1)];
    }

    private static ChatActionField Field(JsonProperty property)
    {
        var label = Label(property.Name);
        var value = property.Value;
        return value.ValueKind switch
        {
            JsonValueKind.String => Text(label, value.GetString()!),
            JsonValueKind.Null => new ChatActionField(label, "none", ChatFieldKind.Line),
            JsonValueKind.Object or JsonValueKind.Array => new ChatActionField(label, Pretty(value), ChatFieldKind.Json),
            _ => new ChatActionField(label, value.GetRawText(), ChatFieldKind.Line),
        };
    }

    private static ChatActionField Text(string label, string text)
    {
        if (text.Length == 0)
        {
            return new ChatActionField(label, "(empty)", ChatFieldKind.Line);
        }

        return new ChatActionField(label, text, text.Contains('\n') || text.Length > LongestLine ? ChatFieldKind.Prose : ChatFieldKind.Line);
    }

    [GeneratedRegex(@"(?<=[a-z0-9])(?=[A-Z])|[_\-\s]+")]
    private static partial Regex WordBreak();
}
