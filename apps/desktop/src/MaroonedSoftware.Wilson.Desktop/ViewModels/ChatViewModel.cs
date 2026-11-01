using System.Collections.ObjectModel;
using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.Core.Chat;
using MaroonedSoftware.Wilson.Desktop.Core.Net;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>A proposed action, as drawn. It runs only once the operator confirms it.</summary>
public sealed record ActionRow(string Id, string Summary, string Status, bool Awaiting);

/// <summary>One chat. The stored thread is the record, and the stream is only what is still arriving.</summary>
public sealed partial class ChatViewModel(ShellViewModel shell, string id, Func<Task> answered) : PageViewModel
{
    private string _rawDraft = string.Empty;

    public ObservableCollection<TranscriptLine> Lines { get; } = [];

    public ObservableCollection<ActionRow> Actions { get; } = [];

    public ObservableCollection<string> Suggestions { get; } = [];

    [ObservableProperty]
    private string _title = "Chat";

    [ObservableProperty]
    private string _draft = string.Empty;

    [ObservableProperty]
    private string? _composer;

    [ObservableProperty]
    private string? _sent;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Idle))]
    private bool _sending;

    [ObservableProperty]
    private string? _error;

    public bool Idle => !Sending;

    [RelayCommand]
    public Task SendAsync() => SayAsync(Composer?.Trim() ?? string.Empty);

    [RelayCommand]
    public Task SuggestAsync(string suggestion) => SayAsync(suggestion);

    [RelayCommand]
    public Task ConfirmAsync(ActionRow action) => DecideAsync(action, DecideChatActionRequestDecision.Confirm);

    [RelayCommand]
    public Task DeclineAsync(ActionRow action) => DecideAsync(action, DecideChatActionRequestDecision.Decline);

    protected override async Task OnShownAsync(CancellationToken cancellationToken)
    {
        await LoadAsync(cancellationToken);
        await shell.Connection!.FollowAsync(
            $"/api/chat/threads/{Uri.EscapeDataString(id)}/stream",
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
    }

    private async Task LoadAsync(CancellationToken cancellationToken)
    {
        try
        {
            var detail = await shell.Connection!.Sdk.Chat.GetAChatThreadAsync(id, cancellationToken);
            Title = detail.Thread.Title;
            Lines.Clear();
            foreach (var message in detail.Messages)
            {
                Lines.Add(new TranscriptLine(message.Role == ChatMessageRole.User ? "You" : "Wilson", message.Content));
            }

            Actions.Clear();
            foreach (var action in detail.Actions)
            {
                var awaiting = ChatRules.IsAwaiting(action, DateTimeOffset.UtcNow);
                Actions.Add(new ActionRow(action.Id, action.Summary, awaiting ? "Waiting for you" : action.Error ?? action.Status.ToString(), awaiting));
            }

            Suggestions.Clear();
            foreach (var suggestion in detail.Messages.LastOrDefault()?.Suggestions ?? [])
            {
                Suggestions.Add(suggestion);
            }
        }
        catch (HttpRequestException failure)
        {
            Error = ApiError.Reason(failure);
        }
    }

    private async Task SayAsync(string text)
    {
        if (text.Length == 0)
        {
            return;
        }

        Sending = true;
        Composer = null;
        Sent = text;
        Error = null;
        try
        {
            await shell.Connection!.Sdk.Chat.SendAChatMessageAsync(id, new SendChatMessageRequest { Text = text, Project = shell.Settings.Project });
        }
        catch (HttpRequestException failure)
        {
            Composer = text;
            Error = ApiError.Reason(failure);
        }

        await LoadAsync(CancellationToken.None);
        ClearDraft();
        Sent = null;
        Sending = false;
        await answered();
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
