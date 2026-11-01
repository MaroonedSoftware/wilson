namespace MaroonedSoftware.Wilson.Desktop.Core.Auth;

/// <summary>Where a signed-in session is kept between launches: the operating system's credential store.</summary>
/// <remarks>
/// The seam exists so another platform is one class rather than a branch through the session code.
/// The Android app keeps its tokens in a file; a desktop is more likely to be a shared machine.
/// </remarks>
public interface ISecretStore
{
    /// <summary>The session for a server, or null when there is none.</summary>
    Task<StoredSession?> ReadAsync(string origin, CancellationToken cancellationToken = default);

    /// <exception cref="SecretStoreException">When the store refuses to keep it.</exception>
    Task WriteAsync(StoredSession session, CancellationToken cancellationToken = default);

    Task DeleteAsync(string origin, CancellationToken cancellationToken = default);
}

/// <summary>A store that forgets when the process does. For tests, and for a platform with none yet.</summary>
public sealed class InMemorySecretStore : ISecretStore
{
    private readonly Dictionary<string, StoredSession> _sessions = [];
    private readonly Lock _gate = new();

    public Task<StoredSession?> ReadAsync(string origin, CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            return Task.FromResult(_sessions.GetValueOrDefault(origin));
        }
    }

    public Task WriteAsync(StoredSession session, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(session);

        lock (_gate)
        {
            _sessions[session.Origin] = session;
        }

        return Task.CompletedTask;
    }

    public Task DeleteAsync(string origin, CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            _sessions.Remove(origin);
        }

        return Task.CompletedTask;
    }
}

/// <summary>The credential store refused to keep something.</summary>
public sealed class SecretStoreException : Exception
{
    public SecretStoreException()
    {
    }

    public SecretStoreException(string message)
        : base(message)
    {
    }

    public SecretStoreException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
