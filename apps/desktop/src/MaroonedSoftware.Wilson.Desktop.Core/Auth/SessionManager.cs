using MaroonedSoftware.Wilson.Sdk;
using MaroonedSoftware.Wilson.Sdk.Models;
using MaroonedSoftware.Wilson.Sdk.Runtime;

namespace MaroonedSoftware.Wilson.Desktop.Core.Auth;

/// <summary>The signed-in half of the app, for one server.</summary>
/// <remarks>
/// <para>
/// <b>A refresh is single-flight.</b> Refresh tokens are single-use and presenting a spent one
/// revokes the whole family, so two callers meeting the same 401 is the ordinary case. The first
/// thing inside the lock is to check the token it set out to replace is still current.
/// </para>
/// <para>
/// <b>A session ends only when the API refuses the refresh</b> (<see cref="ApiError.RefusesRefresh"/>).
/// A network failure, a 5xx or a proxy's answer changes nothing.
/// </para>
/// </remarks>
public sealed class SessionManager(string origin, WilsonSdk sdk, ISecretStore store) : IDisposable
{
    /// <summary>
    /// How long a token request may take. The shared client has no timeout, because a merge runs the
    /// suite before answering, so a sign-in against a dead server would otherwise wait forever.
    /// </summary>
    private static readonly TimeSpan TokenTimeout = TimeSpan.FromSeconds(15);

    private readonly SemaphoreSlim _refresh = new(1, 1);
    private StoredSession? _session;
    private string? _pendingEmail;

    /// <summary>Raised when the API ends the session, so the app can go back to signing in.</summary>
    public event EventHandler? SessionEnded;

    public string? AccessToken => Volatile.Read(ref _session)?.AccessToken;

    public string? Email => Volatile.Read(ref _session)?.Email;

    public bool IsSignedIn => Volatile.Read(ref _session) is not null;

    /// <summary>Picks up the session kept from last time, if any. Nothing is asked of the server.</summary>
    public async Task RestoreAsync(CancellationToken cancellationToken = default)
    {
        Volatile.Write(ref _session, await store.ReadAsync(origin, cancellationToken).ConfigureAwait(false));
    }

    public async Task<SignInResult> SignInAsync(string email, string password, CancellationToken cancellationToken = default)
    {
        var request = new TokenRequest { GrantType = TokenRequestGrantType.Password, Email = email, Password = password };
        return await RequestAsync(request, email, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>The second step, answering <see cref="SignInResult.CodeNeeded"/>.</summary>
    public async Task<SignInResult> CompleteSignInAsync(SignInResult.CodeNeeded pending, string code, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(pending);

        var request = new TokenRequest
        {
            GrantType = TokenRequestGrantType.Authenticator,
            ChallengeId = pending.ChallengeId,
            FactorId = pending.FactorId,
            Code = code,
        };
        return await RequestAsync(request, _pendingEmail ?? string.Empty, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>A new access token to replace <paramref name="staleToken"/>, which a request just had refused.</summary>
    public async Task<RefreshOutcome> RefreshedAsync(string staleToken, CancellationToken cancellationToken = default)
    {
        await _refresh.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var current = Volatile.Read(ref _session);
            if (current is null)
            {
                return new RefreshOutcome.SessionEnded();
            }

            if (current.AccessToken != staleToken)
            {
                return new RefreshOutcome.Renewed(current.AccessToken);
            }

            TokenResponse response;
            try
            {
                using var timeout = Timed(cancellationToken);
                response = await sdk.Auth
                    .RequestTokenAsync(new TokenRequest { GrantType = TokenRequestGrantType.RefreshToken, RefreshToken = current.RefreshToken }, timeout.Token)
                    .ConfigureAwait(false);
            }
            catch (SdkException failure) when (ApiError.RefusesRefresh(failure))
            {
                await EndAsync().ConfigureAwait(false);
                return new RefreshOutcome.SessionEnded();
            }
            catch (Exception failure) when (IsUnreachable(failure, cancellationToken))
            {
                return new RefreshOutcome.Unavailable();
            }

            if (response.AccessToken is not { } accessToken)
            {
                return new RefreshOutcome.Unavailable();
            }

            await AdoptAsync(current with { AccessToken = accessToken, RefreshToken = response.RefreshToken ?? current.RefreshToken }).ConfigureAwait(false);
            return new RefreshOutcome.Renewed(accessToken);
        }
        finally
        {
            _refresh.Release();
        }
    }

    /// <summary>
    /// Tells the server first, because that request carries the token, and forgets the session here
    /// whatever it answers: a server that cannot be reached must not keep anybody signed in.
    /// </summary>
    public async Task SignOutAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            using var timeout = Timed(cancellationToken);
            await sdk.Auth.LogoutAsync(timeout.Token).ConfigureAwait(false);
        }
        catch (Exception failure) when (IsUnreachable(failure, cancellationToken))
        {
            // The session dies on its own schedule on the server; this machine has already let go.
        }
        finally
        {
            Volatile.Write(ref _session, null);
            await store.DeleteAsync(origin, CancellationToken.None).ConfigureAwait(false);
        }
    }

    public void Dispose() => _refresh.Dispose();

    private static CancellationTokenSource Timed(CancellationToken cancellationToken)
    {
        var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TokenTimeout);
        return timeout;
    }

    /// <summary>A failed request or our own timeout, but never the caller changing its mind.</summary>
    private static bool IsUnreachable(Exception failure, CancellationToken cancellationToken) =>
        failure is HttpRequestException || (failure is OperationCanceledException && !cancellationToken.IsCancellationRequested);

    private async Task<SignInResult> RequestAsync(TokenRequest request, string email, CancellationToken cancellationToken)
    {
        TokenResponse response;
        try
        {
            using var timeout = Timed(cancellationToken);
            response = await sdk.Auth.RequestTokenAsync(request, timeout.Token).ConfigureAwait(false);
        }
        catch (SdkException failure)
        {
            return failure.Status switch
            {
                401 => new SignInResult.Refused(),
                429 => new SignInResult.TooManyAttempts(),
                _ => new SignInResult.Unavailable(ApiError.Message(failure)),
            };
        }
        catch (Exception failure) when (IsUnreachable(failure, cancellationToken))
        {
            return new SignInResult.Unavailable(null);
        }

        if (response is { Result: TokenResponseResult.MfaRequired, ChallengeId: { } challengeId })
        {
            _pendingEmail = email;

            // Every enrolled factor is listed, and only an authenticator can be answered here.
            var factor = response.Factors?.FirstOrDefault(candidate => candidate.Method == MfaFactorMethod.Authenticator);
            return factor is null ? new SignInResult.PasskeyOnly() : new SignInResult.CodeNeeded(challengeId, factor.Id, factor.Label);
        }

        if (response is not { AccessToken: { } accessToken, RefreshToken: { } refreshToken })
        {
            return new SignInResult.Unavailable(null);
        }

        await AdoptAsync(new StoredSession { Origin = origin, Email = email, AccessToken = accessToken, RefreshToken = refreshToken }).ConfigureAwait(false);
        return new SignInResult.SignedIn();
    }

    private async Task AdoptAsync(StoredSession session)
    {
        Volatile.Write(ref _session, session);
        try
        {
            await store.WriteAsync(session, CancellationToken.None).ConfigureAwait(false);
        }
        catch (SecretStoreException)
        {
            // A locked Keychain or a denied prompt. The session works for this run and is simply not
            // remembered, which is a sign-in next launch rather than a broken app.
        }
    }

    private async Task EndAsync()
    {
        Volatile.Write(ref _session, null);
        await store.DeleteAsync(origin, CancellationToken.None).ConfigureAwait(false);
        SessionEnded?.Invoke(this, EventArgs.Empty);
    }
}
