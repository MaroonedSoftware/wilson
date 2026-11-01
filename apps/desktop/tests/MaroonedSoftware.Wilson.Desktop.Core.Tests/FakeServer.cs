using System.Net;
using System.Text;

namespace MaroonedSoftware.Wilson.Desktop.Core.Tests;

/// <summary>The bottom of the handler stack: answers from a function and records what it was asked.</summary>
internal sealed class FakeServer(Func<HttpRequestMessage, string?, HttpResponseMessage> answer) : HttpMessageHandler
{
    public List<(string Path, string? Bearer, string? Body)> Requests { get; } = [];

    public static HttpResponseMessage Json(HttpStatusCode status, string body, string? challenge = null)
    {
        var response = new HttpResponseMessage(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        if (challenge is not null)
        {
            response.Headers.TryAddWithoutValidation("WWW-Authenticate", challenge);
        }

        return response;
    }

    public static string Token(string access, string refresh) =>
        $$"""{"result":"token","accessToken":"{{access}}","refreshToken":"{{refresh}}","expiresIn":3600,"tokenType":"Bearer"}""";

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
        lock (Requests)
        {
            Requests.Add((request.RequestUri!.AbsolutePath, request.Headers.Authorization?.Parameter, body));
        }

        return answer(request, body);
    }
}
