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

    /// <summary>The sentence to show for a failed call: the API's own when it sent one.</summary>
    public static string Reason(Exception failure)
    {
        ArgumentNullException.ThrowIfNull(failure);

        return failure switch
        {
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

        return failure.Status == 403
            && Details(failure) is { } details
            && details.TryGetProperty("kind", out var kind)
            && kind.ValueKind == JsonValueKind.String
            && kind.GetString() == "step_up_required";
    }

    private static JsonElement? Details(SdkException failure) =>
        failure.Json is { ValueKind: JsonValueKind.Object } body
        && body.TryGetProperty("details", out var details)
        && details.ValueKind == JsonValueKind.Object
            ? details
            : null;

    [GeneratedRegex("error=\"(invalid_request|invalid_token|invalid_grant)\"")]
    private static partial Regex RefreshRefusal();
}
