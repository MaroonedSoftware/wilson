using System.Text.Json;
using System.Text.RegularExpressions;
using MaroonedSoftware.Wilson.Sdk.Runtime;

namespace MaroonedSoftware.Wilson.Desktop.Core.Auth;

/// <summary>Reading what the API said went wrong.</summary>
public static partial class ApiError
{
    /// <summary>The API's own sentence when it sent one: `details.reason`, the field Wilson's refusals use.</summary>
    public static string? Message(SdkException failure)
    {
        ArgumentNullException.ThrowIfNull(failure);

        return Details(failure) is { } details
            && details.TryGetProperty("reason", out var reason)
            && reason.ValueKind == JsonValueKind.String
                ? reason.GetString()
                : null;
    }

    /// <summary>The password policy's advice: `details.password` and `details.suggestions`, not the `details.reason` other refusals use.</summary>
    public static string? PasswordAdvice(SdkException failure)
    {
        ArgumentNullException.ThrowIfNull(failure);

        if (Details(failure) is not { } details)
        {
            return null;
        }

        var warned = details.TryGetProperty("password", out var password);
        var suggested = details.TryGetProperty("suggestions", out var suggestions) && suggestions.ValueKind == JsonValueKind.Array;
        if (!warned && !suggested)
        {
            return null;
        }

        var advice = new List<string?> { warned && password.ValueKind == JsonValueKind.String ? password.GetString() : null };
        if (suggested)
        {
            advice.AddRange(suggestions.EnumerateArray().Where(item => item.ValueKind == JsonValueKind.String).Select(item => item.GetString()));
        }

        return string.Join(' ', advice.Where(text => !string.IsNullOrEmpty(text)));
    }

    /// <summary>The sentence to show for a failed call: the API's own when it sent one.</summary>
    public static string Reason(Exception failure)
    {
        ArgumentNullException.ThrowIfNull(failure);

        return failure switch
        {
            SdkException refused when IsStepUpRequired(refused) => "This change needs you to sign in again.",
            SdkException refused => Message(refused)
                ?? (refused.Json is { ValueKind: JsonValueKind.Object } body && body.TryGetProperty("message", out var message) && message.ValueKind == JsonValueKind.String ? message.GetString() : null)
                ?? FormattableString.Invariant($"The server answered {refused.Status}."),
            HttpRequestException => "Could not reach the server.",
            _ => failure.Message,
        };
    }

    /// <summary>
    /// Whether the API itself refused a refresh, which is the only answer that ends a session. A 401
    /// naming the refusal in `WWW-Authenticate` rather than any 4xx: a proxy or a tunnel can answer
    /// 401 without having looked at the token, and it names none of these. The same rule as
    /// `refusesRefresh` in the Android app.
    /// </summary>
    public static bool RefusesRefresh(SdkException failure)
    {
        ArgumentNullException.ThrowIfNull(failure);

        return failure.Status == 401
            && failure.ResponseHeaders?.WwwAuthenticate.Any(value => value.Parameter is { } parameter && RefreshRefusal().IsMatch(parameter)) == true;
    }

    /// <summary>Whether this 403 asks for a recently proved factor rather than refusing outright.</summary>
    public static bool IsStepUpRequired(SdkException failure)
    {
        ArgumentNullException.ThrowIfNull(failure);

        return failure.Status == 403 && AsksForStepUp(Details(failure));
    }

    /// <summary>The same question of a body not yet turned into an exception, for <see cref="SessionHandler"/>.</summary>
    public static bool IsStepUpRequired(string? body)
    {
        try
        {
            using var document = JsonDocument.Parse(body ?? string.Empty);
            return AsksForStepUp(Details(document.RootElement));
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static bool AsksForStepUp(JsonElement? details) =>
        details is { } found
        && found.TryGetProperty("kind", out var kind)
        && kind.ValueKind == JsonValueKind.String
        && kind.GetString() == "step_up_required";

    private static JsonElement? Details(SdkException failure) => failure.Json is { } body ? Details(body) : null;

    private static JsonElement? Details(JsonElement body) =>
        body is { ValueKind: JsonValueKind.Object }
        && body.TryGetProperty("details", out var details)
        && details.ValueKind == JsonValueKind.Object
            ? details
            : null;

    [GeneratedRegex("error=\"(invalid_request|invalid_token|invalid_grant)\"")]
    private static partial Regex RefreshRefusal();
}
