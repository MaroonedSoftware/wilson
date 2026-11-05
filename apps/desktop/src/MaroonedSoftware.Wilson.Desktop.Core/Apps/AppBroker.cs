using System.Text.Json;
using System.Text.RegularExpressions;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.Core.Apps;

/// <summary>
/// Everything an operator app can have read for it, as JSON from the API. Nothing else is in scope for
/// <see cref="AppBroker"/> to be asked for, so there is no write here to reach.
/// </summary>
public interface IAppReads
{
    Task<string> ListCardsAsync(CancellationToken cancellationToken);

    Task<string> GetCardAsync(string id, CancellationToken cancellationToken);

    Task<string> ListBoardColumnsAsync(CancellationToken cancellationToken);

    Task<string> ListProjectActivityAsync(long? limit, long? before, CancellationToken cancellationToken);

    Task<string> GetProjectStatsAsync(long? days, CancellationToken cancellationToken);
}

/// <summary>
/// Answers one open app's requests, which is `app.broker.ts` in the web app. An app holds no credential,
/// so this table is the whole of its authority: a method missing here, or a grant the app was not
/// installed with, cannot be reached by anything it sends. Everything it sends is treated as hostile.
/// </summary>
/// <remarks>
/// Requests and answers are JSON text, as they cross into native code. An answer's result is the API's
/// own bytes rather than a model written back out, so an app reads what the web app's does, and a value
/// newer than this build's SDK cannot fail the write.
/// </remarks>
public sealed partial class AppBroker : IDisposable
{
    /// <summary>The most requests one app may have waiting, so a loop in it cannot pile work onto the API.</summary>
    public const int MaxRequestsInFlight = 16;

    /// <summary>No request has any reason to be this long, so one that is is not parsed at all.</summary>
    public const int MaxRequestChars = 64 * 1024;

    private const long MaxSafeInteger = (1L << 53) - 1;

    /// <summary>Case-sensitive and by exact name, so a name like `constructor` finds nothing.</summary>
    private static readonly Dictionary<string, Method> Methods = new(StringComparer.Ordinal)
    {
        ["listCards"] = new(AppGrant.BoardRead, (reads, args, token) =>
        {
            NoArguments(args);
            return reads.ListCardsAsync(token);
        }),
        ["getCard"] = new(AppGrant.BoardRead, (reads, args, token) => reads.GetCardAsync(CardId(args), token)),
        ["listBoardColumns"] = new(AppGrant.BoardRead, (reads, args, token) =>
        {
            NoArguments(args);
            return reads.ListBoardColumnsAsync(token);
        }),
        ["listProjectActivity"] = new(AppGrant.ActivityRead, (reads, args, token) =>
        {
            var query = WholeNumbers(args, "limit", "before");
            return reads.ListProjectActivityAsync(query.GetValueOrDefault("limit"), query.GetValueOrDefault("before"), token);
        }),
        ["getProjectStats"] = new(AppGrant.StatsRead, (reads, args, token) =>
        {
            var query = WholeNumbers(args, "days");
            return reads.GetProjectStatsAsync(query.GetValueOrDefault("days"), token);
        }),
    };

    private readonly HashSet<AppGrant> _grants;
    private readonly IAppReads _reads;
    private readonly Action<string> _send;
    private readonly CancellationTokenSource _closed = new();
    private int _inFlight;
    private int _disposed;

    /// <param name="grants">What the app was installed with.</param>
    /// <param name="reads">The API, already fixed to the one project the app was opened in.</param>
    /// <param name="send">Takes an answer back to the app. Never called once this is disposed.</param>
    public AppBroker(IEnumerable<AppGrant> grants, IAppReads reads, Action<string> send)
    {
        ArgumentNullException.ThrowIfNull(grants);
        ArgumentNullException.ThrowIfNull(reads);
        ArgumentNullException.ThrowIfNull(send);

        _grants = [.. grants];
        _reads = reads;
        _send = send;
    }

    /// <summary>The method names this table holds, for a test to hold against the document's.</summary>
    public static IEnumerable<string> MethodNames => Methods.Keys;

    /// <summary>Takes one message from the app. What is not a request has no id to answer, so it goes nowhere.</summary>
    public async Task ReceiveAsync(string message)
    {
        ArgumentNullException.ThrowIfNull(message);

        if (_closed.IsCancellationRequested || !TryReadRequest(message, out var request))
        {
            return;
        }

        if (Interlocked.Increment(ref _inFlight) > MaxRequestsInFlight)
        {
            Interlocked.Decrement(ref _inFlight);
            Send(Refused(request.Id, "too many requests at once"));
            return;
        }

        try
        {
            var answer = await AnswerAsync(request, _closed.Token).ConfigureAwait(false);
            Send(answer);
        }
        catch (OperationCanceledException) when (_closed.IsCancellationRequested)
        {
            // Closing the app is how its requests end.
        }
        finally
        {
            Interlocked.Decrement(ref _inFlight);
        }
    }

    /// <summary>Stops answering. What is on its way is dropped, as a closed port drops it.</summary>
    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 0)
        {
            _closed.Cancel();
            _closed.Dispose();
        }
    }

    private static bool TryReadRequest(string message, out Request request)
    {
        request = default;
        if (message.Length > MaxRequestChars)
        {
            return false;
        }

        try
        {
            using var document = JsonDocument.Parse(message);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("id", out var id) || id.ValueKind != JsonValueKind.Number
                || !root.TryGetProperty("method", out var method) || method.ValueKind != JsonValueKind.String
                || !root.TryGetProperty("args", out var args) || args.ValueKind != JsonValueKind.Array)
            {
                return false;
            }

            // Cloned, as the document does not outlive this method.
            request = new Request(id.GetRawText(), method.GetString()!, [.. args.EnumerateArray().Select(arg => arg.Clone())]);
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static void NoArguments(JsonElement[] args)
    {
        if (args.Length > 0)
        {
            throw new AppRequestException("this method takes no arguments");
        }
    }

    private static string CardId(JsonElement[] args)
    {
        if (args is [{ ValueKind: JsonValueKind.String } id] && CardIdPattern().IsMatch(id.GetString()!))
        {
            return id.GetString()!;
        }

        throw new AppRequestException("expected one card id");
    }

    /// <summary>
    /// An optional query holding only these keys, each a whole number. A null is the same as nothing,
    /// since `undefined` reads as null by the time a request is JSON.
    /// </summary>
    private static Dictionary<string, long?> WholeNumbers(JsonElement[] args, params string[] keys)
    {
        if (args.Length > 1)
        {
            throw new AppRequestException("expected at most one query");
        }

        var result = new Dictionary<string, long?>(StringComparer.Ordinal);
        if (args.Length == 0 || args[0].ValueKind == JsonValueKind.Null)
        {
            return result;
        }

        if (args[0].ValueKind != JsonValueKind.Object)
        {
            throw new AppRequestException("expected a query object");
        }

        foreach (var field in args[0].EnumerateObject())
        {
            if (!keys.Contains(field.Name, StringComparer.Ordinal))
            {
                throw new AppRequestException($"unknown query field \"{field.Name}\"");
            }

            if (field.Value.ValueKind != JsonValueKind.Number || !field.Value.TryGetInt64(out var value) || value < 0 || value > MaxSafeInteger)
            {
                throw new AppRequestException($"{field.Name} must be a whole number");
            }

            result[field.Name] = value;
        }

        return result;
    }

    private static string Refused(string id, string error) => $$"""{"id":{{id}},"ok":false,"error":{{JsonSerializer.Serialize(error)}}}""";

    [GeneratedRegex(@"\A[A-Za-z0-9][A-Za-z0-9_-]{0,63}\z")]
    private static partial Regex CardIdPattern();

    private async Task<string> AnswerAsync(Request request, CancellationToken cancellationToken)
    {
        if (!Methods.TryGetValue(request.Name, out var method))
        {
            return Refused(request.Id, $"no method \"{request.Name}\"");
        }

        if (!_grants.Contains(method.Grant))
        {
            return Refused(request.Id, $"{request.Name} needs the {AppDocument.GrantName(method.Grant)} grant, which this app was not installed with");
        }

        try
        {
            var result = await method.Run(_reads, request.Args, cancellationToken).ConfigureAwait(false);

            // Read before it goes into a reply, so whatever the server said cannot end up as anything but one value.
            using var checkedResult = JsonDocument.Parse(result);
            return $$"""{"id":{{request.Id}},"ok":true,"result":{{checkedResult.RootElement.GetRawText()}}}""";
        }
        catch (AppRequestException refusal)
        {
            return Refused(request.Id, refusal.Message);
        }
        catch (HttpRequestException failure)
        {
            return Refused(request.Id, ApiError.Reason(failure));
        }
        catch (JsonException)
        {
            return Refused(request.Id, "the server's answer could not be read");
        }
    }

    private void Send(string answer)
    {
        if (!_closed.IsCancellationRequested)
        {
            _send(answer);
        }
    }

    /// <summary>One thing an app can ask for: the grant it takes, and how arguments become a call.</summary>
    private sealed record Method(AppGrant Grant, Func<IAppReads, JsonElement[], CancellationToken, Task<string>> Run);

    private readonly record struct Request(string Id, string Name, JsonElement[] Args);

    /// <summary>Refused rather than sent on. Its message goes back to the app.</summary>
    private sealed class AppRequestException(string message) : Exception(message);
}
