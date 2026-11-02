using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.Core.Runner;
using MaroonedSoftware.Wilson.Sdk;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>A line of `DeploymentFacts`.</summary>
public sealed record DeploymentFact(string Label, string Value, bool Topology);

/// <summary>`routes/settings.tsx`, the deployment's own settings. Bounds here are only hints: the API refuses out of range whatever these let through.</summary>
public sealed partial class SettingsViewModel : PageViewModel
{
    private static readonly TimeSpan DrainReading = TimeSpan.FromSeconds(5);

    private readonly ShellViewModel _shell;

    public SettingsViewModel(ShellViewModel shell)
    {
        _shell = shell;
        AutoMode = new SwitchSetting(
            "Auto-mode",
            "Whether the runner picks up cards on its own, without a human dispatching them.",
            "auto-mode",
            async token => (await Sdk.Settings.GetPollerSettingAsync(token)).Enabled,
            async on => (await Sdk.Settings.SetPollerSettingAsync(new SetPollerSettingRequest { Enabled = on })).Enabled);
        Drain = new SwitchSetting(
            "Drain",
            "Lets running stages finish and starts nothing new, across every project. Stays on through a restart until turned off.",
            "drain status",
            async token => Reported(await Sdk.Settings.GetDrainStatusAsync(token)),
            async on => Reported(await Sdk.Settings.SetDrainAsync(new SetDrainRequest { Draining = on })));
        AutoSplit = new SwitchSetting(
            "Auto-split",
            "When scope-check refuses a card, split it into the proposed pieces and draft a plan for each. The plans wait in planning for your approval.",
            "auto-split",
            async token => (await Sdk.Settings.GetAutoSplitSettingAsync(token)).Enabled,
            async on => (await Sdk.Settings.SetAutoSplitSettingAsync(new SetAutoSplitSettingRequest { Enabled = on })).Enabled);
        PollInterval = new NumberSetting(
            "Poll interval (ms)",
            "How often the poller checks the board for a card to enqueue.",
            "poll interval",
            5_000,
            300_000,
            1_000,
            async token => (await Sdk.Settings.GetPollerIntervalAsync(token)).IntervalMs,
            async value => (await Sdk.Settings.SetPollerIntervalAsync(new SetPollerIntervalRequest { IntervalMs = value })).IntervalMs);
        Concurrency = new NumberSetting(
            "Concurrent stages",
            "How many card.stage jobs run at once, on this machine and every registered host together. Applies once no stage is currently running, never mid-run.",
            "card stage concurrency",
            1,
            32,
            1,
            async token => (await Sdk.Settings.GetCardStageConcurrencyAsync(token)).Concurrency,
            async value => (await Sdk.Settings.SetCardStageConcurrencyAsync(new SetCardStageConcurrencyRequest { Concurrency = value })).Concurrency);
        LocalSlots = new NumberSetting(
            "Stages on this machine",
            "How many stages may hold a worktree here at once, out of the total above. Applies to the next stage.",
            "local stage slots",
            1,
            8,
            1,
            async token => (await Sdk.Settings.GetLocalStageSlotsAsync(token)).Slots,
            async value => (await Sdk.Settings.SetLocalStageSlotsAsync(new SetLocalStageSlotsRequest { Slots = value })).Slots);
        ClaudeConfigDir = new TextSetting(
            "Claude config directory",
            "Where the engine reads its Claude Code credentials from. Must already be authenticated: pointing this at an unauthenticated directory fails every cli-adapter stage at the model call. Leave empty to use the daemon's own default. A change applies to stages started afterwards, never one already running.",
            "/home/operator/.claude-wilson",
            "claude config directory",
            async token => (await Sdk.Settings.GetClaudeConfigDirSettingAsync(token)).ConfigDir,
            async value => (await Sdk.Settings.SetClaudeConfigDirSettingAsync(new SetClaudeConfigDirSettingRequest { ConfigDir = value })).ConfigDir);
        GitHubApp = new TextSetting(
            "GitHub App ID",
            "Lets Wilson clone repositories when adding a project. Shown on the app's settings page on GitHub. Takes effect without a restart.",
            "123456",
            "GitHub App",
            async token => Reported(await Sdk.Settings.GetGithubAppSettingAsync(token)),
            async value => Reported(await Sdk.Settings.SetGithubAppSettingAsync(new SetGitHubAppSettingRequest { AppId = value })));
        EngineToken = new EngineTokenControl(() => Sdk);
        WorkerTokens = new WorkerTokensControl(() => Sdk);
        ChatEngine = new ChatEngineControl(() => Sdk);
    }

    public ShellViewModel Shell => _shell;

    public SwitchSetting AutoMode { get; }

    public SwitchSetting Drain { get; }

    public SwitchSetting AutoSplit { get; }

    public NumberSetting PollInterval { get; }

    public NumberSetting Concurrency { get; }

    public NumberSetting LocalSlots { get; }

    public TextSetting ClaudeConfigDir { get; }

    public EngineTokenControl EngineToken { get; }

    public WorkerTokensControl WorkerTokens { get; }

    public TextSetting GitHubApp { get; }

    public ChatEngineControl ChatEngine { get; }

    public IReadOnlyList<DeploymentFact> Facts { get; private set; } = [];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(WebhookDirty))]
    private string? _webhookDraft;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(WebhookDirty))]
    private string? _baseUrlDraft;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(WebhookDirty))]
    private NotifyWebhookSetting? _webhook;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(WebhookDirty))]
    private bool _webhookIdle = true;

    [ObservableProperty]
    private string? _webhookError;

    [ObservableProperty]
    private string? _webhookStillSaved;

    [ObservableProperty]
    private string? _deploymentError;

    [ObservableProperty]
    private string? _gitHubKey;

    [ObservableProperty]
    private bool _gitHubKeyMissing;

    public bool WebhookDirty => WebhookIdle && Webhook is { } stored
        && ((WebhookDraft ?? string.Empty) != (stored.WebhookUrl ?? string.Empty) || (BaseUrlDraft ?? string.Empty) != (stored.BaseUrl ?? string.Empty));

    private WilsonSdk Sdk => _shell.Connection!.Sdk;

    /// <summary>The server's own check is the only one: a client's URL rule that disagreed with it would be worse than none.</summary>
    [RelayCommand]
    public async Task SaveWebhookAsync()
    {
        if (!WebhookDirty)
        {
            return;
        }

        WebhookIdle = false;
        WebhookError = null;
        WebhookStillSaved = null;
        try
        {
            DrawWebhook(await Sdk.Settings.SetNotifyWebhookSettingAsync(new SetNotifyWebhookSettingRequest
            {
                WebhookUrl = SettingsRules.Sent(WebhookDraft),
                BaseUrl = SettingsRules.Sent(BaseUrlDraft),
            }));
        }
        catch (HttpRequestException failure)
        {
            WebhookError = ApiError.Reason(failure);
            WebhookStillSaved = SettingsRules.StillSaved(Webhook?.WebhookUrl);
        }

        WebhookIdle = true;
    }

    protected override async Task OnShownAsync(CancellationToken cancellationToken)
    {
        await Task.WhenAll(
            AutoMode.ReadAsync(cancellationToken),
            Drain.ReadAsync(cancellationToken),
            AutoSplit.ReadAsync(cancellationToken),
            PollInterval.ReadAsync(cancellationToken),
            Concurrency.ReadAsync(cancellationToken),
            LocalSlots.ReadAsync(cancellationToken),
            ReadWebhookAsync(cancellationToken),
            ClaudeConfigDir.ReadAsync(cancellationToken),
            EngineToken.ReadAsync(cancellationToken),
            WorkerTokens.ReadAsync(cancellationToken),
            GitHubApp.ReadAsync(cancellationToken),
            ChatEngine.ReadAsync(cancellationToken),
            ReadDeploymentAsync(cancellationToken));
        await EveryAsync(DrainReading, () => _ = ReadDrainQuietlyAsync(cancellationToken), cancellationToken);
    }

    private bool Reported(DrainStatus status)
    {
        _shell.Drain = status;
        return status.Draining;
    }

    private string? Reported(GitHubAppSetting setting)
    {
        GitHubKey = SettingsRules.GitHubKey(setting.KeyInstalled);
        GitHubKeyMissing = !setting.KeyInstalled;
        return setting.AppId;
    }

    private async Task ReadDrainQuietlyAsync(CancellationToken cancellationToken)
    {
        try
        {
            await Drain.ReadAsync(cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // Leaving the page is how its reading ends.
        }
    }

    private async Task ReadWebhookAsync(CancellationToken cancellationToken)
    {
        try
        {
            DrawWebhook(await Sdk.Settings.GetNotifyWebhookSettingAsync(cancellationToken));
        }
        catch (HttpRequestException failure)
        {
            WebhookError = $"Cannot load notification URLs: {ApiError.Reason(failure)}";
        }
    }

    private void DrawWebhook(NotifyWebhookSetting stored)
    {
        Webhook = stored;
        WebhookDraft = stored.WebhookUrl;
        BaseUrlDraft = stored.BaseUrl;
    }

    private async Task ReadDeploymentAsync(CancellationToken cancellationToken)
    {
        try
        {
            var health = await Sdk.Health.GetHealthAsync(cancellationToken);
            Facts =
            [
                new DeploymentFact("Project", health.Project, false),
                new DeploymentFact("Commit", health.Head, false),
                new DeploymentFact("Started", health.StartedAt.ToLocalTime().ToString("g", System.Globalization.CultureInfo.CurrentCulture), false),
                new DeploymentFact("Code root", health.CodeRoot, true),
                new DeploymentFact("Worktree root", health.WorktreeRoot, true),
            ];
            OnPropertyChanged(nameof(Facts));
        }
        catch (HttpRequestException failure)
        {
            DeploymentError = $"Cannot load deployment facts: {ApiError.Reason(failure)}";
        }
    }
}
