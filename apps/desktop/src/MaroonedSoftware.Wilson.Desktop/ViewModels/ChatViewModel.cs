using System.Collections.ObjectModel;
using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.Core.Chat;
using MaroonedSoftware.Wilson.Desktop.Core.Net;
using MaroonedSoftware.Wilson.Sdk.Models;
using MaroonedSoftware.Wilson.Sdk.Runtime;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>What the person wrote.</summary>
public sealed record UserEntry(string Text);

/// <summary>An answer: what it ran, then what it said.</summary>
public sealed record AnswerEntry(string Text, IReadOnlyList<ChatActivity> Activity)
{
    public bool Ran => Activity.Count > 0;
}

/// <summary>A proposed action, as drawn. It runs only once the operator confirms it.</summary>
public sealed record ActionRow(string Id, string Summary, string Detail, string Arguments, string Status, bool Awaiting, bool Failed, string? Error);

/// <summary>One chat, or a new one until its first message. The stored thread is the record, and the stream is only what is still arriving.</summary>
public sealed partial class ChatViewModel(ShellViewModel shell, ThreadsViewModel home, string? id) : PageViewModel
{
    private const string Ask = "Ask about the board, or tell it what to do";

    /// <summary>How long a new thread's first message waits for the stream, which is not worth losing the message over.</summary>
    private static readonly TimeSpan Listening = TimeSpan.FromSeconds(2);

    private readonly List<ChatOperation> _operations = [];
    private ChatThreadDetail? _read;
    private TaskCompletionSource _live = new();
    private string _rawDraft = string.Empty;

    public string? Id { get; private set; } = id;

    public ObservableCollection<object> Entries { get; } = [];

    public ObservableCollection<ChatActivity> Working { get; } = [];

    public ObservableCollection<string> Suggestions { get; } = [];

    public IReadOnlyList<string> Starters => Id is null ? ChatRules.Starters : [];

    /// <summary>A new chat's promise, naming the project its messages will assume.</summary>
    public string Promise =>
        "Ask about the board, or tell it what to do. It reads on its own; a change waits for you to confirm it."
        + (shell.Settings.Project is { } project ? $" It assumes the {project} project unless you name another." : string.Empty);

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Answering))]
    [NotifyPropertyChangedFor(nameof(Thinking))]
    private string _draft = string.Empty;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSend))]
    [NotifyPropertyChangedFor(nameof(Offered))]
    [NotifyPropertyChangedFor(nameof(Hint))]
    private string? _composer;

    [ObservableProperty]
    private string? _sent;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Idle))]
    [NotifyPropertyChangedFor(nameof(Empty))]
    [NotifyPropertyChangedFor(nameof(Talking))]
    [NotifyPropertyChangedFor(nameof(Answering))]
    [NotifyPropertyChangedFor(nameof(Thinking))]
    [NotifyPropertyChangedFor(nameof(CanSend))]
    [NotifyPropertyChangedFor(nameof(Offered))]
    [NotifyPropertyChangedFor(nameof(Hint))]
    private bool _sending;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Hint))]
    private bool _awaiting;

    [ObservableProperty]
    private string? _error;

    public bool Idle => !Sending;

    /// <summary>A new chat, with nothing said yet: the greeting takes the page.</summary>
    public bool Empty => Id is null && !Sending;

    public bool Talking => !Empty;

    /// <summary>To a message just sent, or the follow-up to a confirmed change.</summary>
    public bool Answering => Sending || Draft.Length > 0 || Working.Count > 0;

    public bool Thinking => Answering && Draft.Length == 0;

    public bool CanSend => !Sending && !string.IsNullOrWhiteSpace(Composer);

    /// <summary>What to ask next: shown in the empty box, and filled in with Tab.</summary>
    public string? Offered => string.IsNullOrEmpty(Composer) && !Sending
        ? (Id is null ? ChatRules.Starters[0] : Suggestions.FirstOrDefault())
        : null;

    public string Hint => Offered ?? (Awaiting ? "Confirm or decline above, or ask for something else…" : Ask);

    [RelayCommand]
    public Task SendAsync() => SayAsync(Composer?.Trim() ?? string.Empty);

    [RelayCommand]
    public Task SuggestAsync(string suggestion) => SayAsync(suggestion);

    [RelayCommand]
    public Task ConfirmAsync(ActionRow action) => DecideAsync(action, DecideChatActionRequestDecision.Confirm);

    [RelayCommand]
    public Task DeclineAsync(ActionRow action) => DecideAsync(action, DecideChatActionRequestDecision.Decline);

    /// <summary>Takes the suggestion into an empty box, answering whether there was one.</summary>
    public bool TakeOffered()
    {
        if (Offered is not { } offered)
        {
            return false;
        }

        Composer = offered;
        return true;
    }

    protected override async Task OnShownAsync(CancellationToken cancellationToken)
    {
        if (Id is not { } thread)
        {
            return;
        }

        await LoadAsync(cancellationToken);
        await shell.Connection!.FollowAsync(
            $"/api/chat/threads/{Uri.EscapeDataString(thread)}/stream",
            null,
            signal => Dispatcher.UIThread.InvokeAsync(() => FollowAsync(signal, cancellationToken)),
            cancellationToken: cancellationToken);
    }

    /// <summary>Chat events are not replayed, so any reconnect re-reads the stored thread.</summary>
    private async Task FollowAsync(StreamSignal signal, CancellationToken cancellationToken)
    {
        switch (signal)
        {
            case StreamSignal.Live:
                _live.TrySetResult();
                await LoadAsync(cancellationToken);
                break;
            case StreamSignal.Received { Event.Event: "proposed" }:
                await LoadAsync(cancellationToken);
                break;
            case StreamSignal.Down:
                ClearDraft();
                break;
            case StreamSignal.Received { Event.Event: "delta" } delta:
                _rawDraft += delta.Event.Data;
                Draft = ChatRules.WithoutSuggestions(_rawDraft);
                break;
            case StreamSignal.Received { Event.Event: "operation" } ran when ChatRules.ReadOperation(ran.Event.Data) is { } operation:
                _operations.Add(operation);
                DrawWorking();
                break;
            case StreamSignal.Received { Event.Event: "done" or "failed" }:
                ClearDraft();
                await LoadAsync(cancellationToken);
                break;
            default:
                break;
        }
    }

    private void ClearDraft()
    {
        _rawDraft = string.Empty;
        Draft = string.Empty;
        _operations.Clear();
        DrawWorking();
    }

    private void DrawWorking()
    {
        Working.Clear();
        foreach (var activity in ChatRules.Activity(_operations))
        {
            Working.Add(activity);
        }

        OnPropertyChanged(nameof(Answering));
        OnPropertyChanged(nameof(Thinking));
    }

    private async Task LoadAsync(CancellationToken cancellationToken)
    {
        if (Id is not { } thread)
        {
            return;
        }

        try
        {
            Draw(await shell.Connection!.Sdk.Chat.GetAChatThreadAsync(thread, cancellationToken));
        }
        catch (SdkException failure) when (failure.Status == 404)
        {
            // Archived elsewhere, or a remembered id from another database.
            home.Gone();
        }
        catch (HttpRequestException failure)
        {
            Error = ApiError.Reason(failure);
        }
    }

    private void Draw(ChatThreadDetail detail)
    {
        var now = DateTimeOffset.UtcNow;
        Entries.Clear();
        foreach (var step in ChatRules.Timeline(detail.Messages, detail.Actions))
        {
            Entries.Add(step switch
            {
                { Action: { } action } => Row(action, now),
                { Message: { Role: ChatMessageRole.User } message } => new UserEntry(message.Content),
                { Message: { } message } => new AnswerEntry(message.Content, ChatRules.Activity(message.Operations)),
                _ => throw new InvalidOperationException("a step is a message or an action"),
            });
        }

        // The stored message takes over from the copy on its way, should it arrive mid-turn.
        if (detail.Messages.LastOrDefault(message => message.Role == ChatMessageRole.User)?.Content == Sent)
        {
            Sent = null;
        }

        Awaiting = detail.Actions.Any(action => ChatRules.IsAwaiting(action, now));
        _read = detail;
        Offer();
    }

    private void Offer()
    {
        Suggestions.Clear();
        foreach (var suggestion in _read is { } detail ? ChatRules.FollowUps(detail, Answering, DateTimeOffset.UtcNow) : [])
        {
            Suggestions.Add(suggestion);
        }

        OnPropertyChanged(nameof(Offered));
        OnPropertyChanged(nameof(Hint));
    }

    private static ActionRow Row(ChatPendingAction action, DateTimeOffset now)
    {
        var awaiting = ChatRules.IsAwaiting(action, now);
        var expired = action.Status == ChatPendingActionStatus.Pending && !awaiting;
        var where = action.Project is { } project ? $" in {project}" : string.Empty;
        var until = awaiting ? $" Expires {ChatRules.Relative(action.ExpiresAt, now)}." : string.Empty;
        return new ActionRow(
            action.Id,
            action.Summary,
            $"Runs {action.Operation}{where} as you.{until}",
            action.Arguments.GetRawText(),
            expired ? "expired" : action.Status.ToString().ToLowerInvariant(),
            awaiting,
            action.Status == ChatPendingActionStatus.Failed,
            action.Error);
    }

    /// <summary>The thread is made before its first message goes, not by it, so the stream is listening when the answer starts.</summary>
    private async Task StartAsync()
    {
        var thread = await shell.Connection!.Sdk.Chat.StartAChatThreadAsync();
        Id = thread.Id;
        OnPropertyChanged(nameof(Empty));
        OnPropertyChanged(nameof(Talking));
        _live = new TaskCompletionSource();
        Shown();
        home.Started(thread.Id);
        await Task.WhenAny(_live.Task, Task.Delay(Listening));
    }

    private async Task SayAsync(string text)
    {
        if (text.Length == 0 || Sending)
        {
            return;
        }

        Sending = true;
        Suggestions.Clear();
        Composer = null;
        Sent = text;
        Error = null;
        try
        {
            if (Id is null)
            {
                await StartAsync();
            }

            await shell.Connection!.Sdk.Chat.SendAChatMessageAsync(Id!, new SendChatMessageRequest { Text = text, Project = shell.Settings.Project });
        }
        catch (HttpRequestException failure)
        {
            // Back in the box, unless something new has been typed since.
            Composer = string.IsNullOrEmpty(Composer) ? text : Composer;
            Error = ApiError.Reason(failure);
        }

        await LoadAsync(CancellationToken.None);
        Sent = null;
        ClearDraft();
        Sending = false;
        Offer();
        await home.AnsweredAsync();
    }

    private async Task DecideAsync(ActionRow action, DecideChatActionRequestDecision decision)
    {
        ArgumentNullException.ThrowIfNull(action);

        try
        {
            await shell.Connection!.Sdk.Chat.DecideAChatActionAsync(action.Id, new DecideChatActionRequest { Decision = decision });
        }
        catch (HttpRequestException failure)
        {
            Error = ApiError.Reason(failure);
        }

        await LoadAsync(CancellationToken.None);
    }
}
