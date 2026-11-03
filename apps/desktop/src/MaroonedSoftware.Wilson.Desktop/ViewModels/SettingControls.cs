using System.Collections.ObjectModel;
using System.Diagnostics;
using Avalonia.Media.Imaging;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.Core.Runner;
using MaroonedSoftware.Wilson.Sdk;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>`AutoModeToggle`: it shows what the server handed back, so a refused write never shows as applied.</summary>
public sealed partial class SwitchSetting(string label, string description, string noun, Func<CancellationToken, Task<bool>> read, Func<bool, Task<bool>> write) : ObservableObject
{
    private bool _drawing;

    public string Label => label;

    public string Description => description;

    [ObservableProperty]
    private bool _on;

    [ObservableProperty]
    private bool _loaded;

    [ObservableProperty]
    private bool _idle = true;

    [ObservableProperty]
    private string? _error;

    public async Task ReadAsync(CancellationToken cancellationToken)
    {
        try
        {
            Draw(await read(cancellationToken));
            Loaded = true;
        }
        catch (HttpRequestException failure)
        {
            Error = $"Cannot load {noun}: {ApiError.Reason(failure)}";
        }
    }

    partial void OnOnChanged(bool value)
    {
        if (!_drawing)
        {
            _ = WriteAsync(value);
        }
    }

    private async Task WriteAsync(bool value)
    {
        Idle = false;
        Error = null;
        try
        {
            Draw(await write(value));
        }
        catch (HttpRequestException failure)
        {
            Draw(!value);
            Error = ApiError.Reason(failure);
        }

        Idle = true;
    }

    private void Draw(bool value)
    {
        _drawing = true;
        On = value;
        _drawing = false;
    }
}

/// <summary>`PollerIntervalControl`: a draft and a Save, as a request per keystroke is no use. A refusal puts the stored value back.</summary>
public sealed partial class NumberSetting(string label, string description, string noun, long minimum, long maximum, long step, Func<CancellationToken, Task<long>> read, Func<long, Task<long>> write) : ObservableObject
{
    public string Label => label;

    public string Description => description;

    public decimal Minimum => minimum;

    public decimal Maximum => maximum;

    public decimal Step => step;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Dirty))]
    private decimal? _draft;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Dirty))]
    private long? _stored;

    [ObservableProperty]
    private bool _loaded;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Dirty))]
    private bool _idle = true;

    [ObservableProperty]
    private string? _error;

    public bool Dirty => Idle && Draft is { } draft && draft != Stored;

    public async Task ReadAsync(CancellationToken cancellationToken)
    {
        try
        {
            Stored = await read(cancellationToken);
            Draft = Stored;
            Loaded = true;
        }
        catch (HttpRequestException failure)
        {
            Error = $"Cannot load {noun}: {ApiError.Reason(failure)}";
        }
    }

    [RelayCommand]
    public async Task SaveAsync()
    {
        if (!Dirty)
        {
            return;
        }

        Idle = false;
        Error = null;
        try
        {
            Stored = await write((long)Draft!.Value);
        }
        catch (HttpRequestException failure)
        {
            Error = ApiError.Reason(failure);
        }

        Draft = Stored;
        Idle = true;
    }
}

/// <summary>`ClaudeConfigDirControl`: a refusal keeps the draft, as a long value is easy to mistype twice, and says what is really stored.</summary>
public sealed partial class TextSetting(string label, string description, string? placeholder, string noun, Func<CancellationToken, Task<string?>> read, Func<string?, Task<string?>> write) : ObservableObject
{
    public string Label => label;

    public string Description => description;

    public string? Placeholder => placeholder;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Dirty))]
    private string? _draft;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Dirty))]
    private string? _stored;

    [ObservableProperty]
    private bool _loaded;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Dirty))]
    private bool _idle = true;

    [ObservableProperty]
    private string? _error;

    [ObservableProperty]
    private string? _stillSaved;

    public bool Dirty => Idle && (Draft ?? string.Empty) != (Stored ?? string.Empty);

    public async Task ReadAsync(CancellationToken cancellationToken)
    {
        try
        {
            Stored = await read(cancellationToken);
            Draft = Stored;
            Loaded = true;
        }
        catch (HttpRequestException failure)
        {
            Error = $"Cannot load {noun}: {ApiError.Reason(failure)}";
        }
    }

    [RelayCommand]
    public async Task SaveAsync()
    {
        if (!Dirty)
        {
            return;
        }

        Idle = false;
        Error = null;
        StillSaved = null;
        try
        {
            Stored = await write(SettingsRules.Sent(Draft));
            Draft = Stored;
        }
        catch (HttpRequestException failure)
        {
            Error = ApiError.Reason(failure);
            StillSaved = SettingsRules.StillSaved(Stored);
        }

        Idle = true;
    }
}

/// <summary>
/// `MachineSignInControl`. Write-only: the API reports where the sign-in comes from and never the token, so
/// the box starts empty, is hidden until asked for, and is emptied by a save. <see cref="AccountsControl"/>
/// reads the accounts and limits, and hands over what is said about this machine.
/// </summary>
public sealed partial class MachineSignInControl(Func<WilsonSdk> sdk) : ObservableObject
{
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSave))]
    private string? _draft;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Source))]
    [NotifyPropertyChangedFor(nameof(CanRemove))]
    [NotifyPropertyChangedFor(nameof(EditAction))]
    private EngineTokenSetting? _setting;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSave))]
    [NotifyPropertyChangedFor(nameof(CanRemove))]
    private bool _idle = true;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Viewing))]
    [NotifyPropertyChangedFor(nameof(CanRemove))]
    private bool _editing;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Viewing))]
    [NotifyPropertyChangedFor(nameof(CanRemove))]
    private bool _confirmingRemove;

    [ObservableProperty]
    private string? _error;

    /// <summary>The limit on this machine's own sign-in, in words.</summary>
    [ObservableProperty]
    private string? _limit;

    /// <summary>Whether rotation has accounts, so nothing here is being used.</summary>
    [ObservableProperty]
    private bool _unused;

    /// <summary>Limits on other sign-ins Wilson holds no token for, such as a worker's own.</summary>
    [ObservableProperty]
    private string? _otherLimits;

    public string? Source => Setting is { } setting ? SettingsRules.EngineTokenSource(setting.Source) : null;

    public string EditAction => Setting?.Source == EngineTokenSettingSource.Database ? "Replace token" : "Add token";

    public bool Viewing => !Editing && !ConfirmingRemove;

    public bool CanSave => Idle && !string.IsNullOrWhiteSpace(Draft);

    public bool CanRemove => Idle && Viewing && Setting?.Source == EngineTokenSettingSource.Database;

    public async Task ReadAsync(CancellationToken cancellationToken)
    {
        try
        {
            Setting = await sdk().Settings.GetEngineTokenSettingAsync(cancellationToken);
        }
        catch (HttpRequestException failure)
        {
            Error = $"Cannot load the engine token: {ApiError.Reason(failure)}";
        }
    }

    [RelayCommand]
    private void AskEdit() => Editing = true;

    [RelayCommand]
    private void CancelEdit()
    {
        Draft = null;
        Editing = false;
    }

    [RelayCommand]
    private void AskRemove() => ConfirmingRemove = true;

    [RelayCommand]
    private void CancelRemove() => ConfirmingRemove = false;

    [RelayCommand]
    public Task SaveAsync() => WriteAsync(Draft);

    [RelayCommand]
    public Task RemoveAsync() => WriteAsync(null);

    private async Task WriteAsync(string? token)
    {
        Idle = false;
        Error = null;
        try
        {
            Setting = await sdk().Settings.SetEngineTokenSettingAsync(new SetEngineTokenSettingRequest { Token = token });
            Draft = null;
            Editing = false;
            ConfirmingRemove = false;
        }
        catch (HttpRequestException failure)
        {
            Error = ApiError.Reason(failure);
        }

        Idle = true;
    }
}

/// <summary>A saved account, as drawn: what it is and what is using it, never the token. Keeps its own errors, so a refusal appears on the account it is about.</summary>
public sealed partial class AccountRow(EngineTokenSummary token, bool next, string? limit, long joinPriority, IReadOnlyList<PriorityChange> moveUp, IReadOnlyList<PriorityChange> moveDown, AccountsControl control) : ObservableObject
{
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSaveReplacement))]
    private string? _replacement;

    [ObservableProperty]
    private bool _replacing;

    [ObservableProperty]
    private bool _confirmingRemove;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSaveReplacement))]
    private bool _idle = true;

    [ObservableProperty]
    private string? _error;

    public AccountsControl Control => control;

    public string Name => token.Name;

    public string Type => AccountRules.TypeOf(token);

    public bool Next => next;

    public string? Limit => limit;

    public string? Hosts => token.Hosts.Count > 0 ? string.Join(", ", token.Hosts) : null;

    public bool InRotation => AccountRules.InRotation(token);

    public bool CanJoin => !token.Pooled;

    public bool CanLeave => token.Pooled;

    public bool CanMoveUp => moveUp.Count > 0;

    public bool CanMoveDown => moveDown.Count > 0;

    public string RemovalWarning => AccountRules.RemovalWarning(token);

    public bool CanSaveReplacement => Idle && !string.IsNullOrWhiteSpace(Replacement);

    [RelayCommand]
    private void AskReplace() => Replacing = true;

    [RelayCommand]
    private void CancelReplace()
    {
        Replacement = null;
        Replacing = false;
    }

    [RelayCommand]
    private void AskRemove() => ConfirmingRemove = true;

    [RelayCommand]
    private void CancelRemove() => ConfirmingRemove = false;

    [RelayCommand]
    private Task SaveReplacementAsync() => WriteAsync(client => client.EngineTokens.PutEngineTokenAsync(Name, new PutEngineTokenRequest { Token = Replacement! }));

    [RelayCommand]
    private Task RemoveAsync() => WriteAsync(client => client.EngineTokens.RemoveEngineTokenAsync(Name));

    [RelayCommand]
    private Task JoinAsync() => WriteAsync(client => client.EngineTokens.UpdateEngineTokenAsync(Name, new UpdateEngineTokenRequest { Pooled = true, Priority = joinPriority }));

    [RelayCommand]
    private Task LeaveAsync() => WriteAsync(client => client.EngineTokens.UpdateEngineTokenAsync(Name, new UpdateEngineTokenRequest { Pooled = false }));

    [RelayCommand]
    private Task MoveUpAsync() => control.MoveAsync(moveUp);

    [RelayCommand]
    private Task MoveDownAsync() => control.MoveAsync(moveDown);

    private async Task WriteAsync(Func<WilsonSdk, Task> write)
    {
        Idle = false;
        Error = null;
        try
        {
            await control.WriteAsync(write);
        }
        catch (HttpRequestException failure)
        {
            Error = ApiError.Reason(failure);
        }

        Idle = true;
    }
}

/// <summary>`AccountsControl`: the named accounts Wilson holds, grouped by how each is used. Write only: the list has names and no token.</summary>
public sealed partial class AccountsControl(Func<WilsonSdk> sdk, MachineSignInControl machine, IClaudeSignIn? signIn = null) : ObservableObject
{
    private CancellationTokenSource? _signInStop;

    public ObservableCollection<AccountRow> Rotation { get; } = [];

    public ObservableCollection<AccountRow> CodexRotation { get; } = [];

    public ObservableCollection<AccountRow> Outside { get; } = [];

    public IReadOnlyList<AccountType> Types { get; } = AccountRules.Types;

    private IReadOnlyList<EngineTokenSummary> _tokens = [];

    [ObservableProperty]
    private string? _headline;

    [ObservableProperty]
    private string? _detail;

    [ObservableProperty]
    private bool _hasRotation;

    [ObservableProperty]
    private bool _hasCodexRotation;

    [ObservableProperty]
    private bool _hasOutside;

    [ObservableProperty]
    private bool _adding;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowsSignIn))]
    [NotifyPropertyChangedFor(nameof(CanSignIn))]
    [NotifyPropertyChangedFor(nameof(PasteHint))]
    private AccountType _newType = AccountRules.Types[0];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSaveNew))]
    [NotifyPropertyChangedFor(nameof(CanSignIn))]
    [NotifyPropertyChangedFor(nameof(NameTaken))]
    private string? _newName;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSaveNew))]
    private string? _newToken;

    [ObservableProperty]
    private bool _joinRotation = true;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSaveNew))]
    [NotifyPropertyChangedFor(nameof(CanSignIn))]
    private bool _idle = true;

    [ObservableProperty]
    private string? _error;

    [ObservableProperty]
    private string? _addError;

    /// <summary>A sign-in is waiting on the person at the browser.</summary>
    [ObservableProperty]
    private bool _signingIn;

    /// <summary>Where the browser was sent, for opening in another one when this one has the wrong account.</summary>
    [ObservableProperty]
    private string? _signInLink;

    private bool TakesSetupToken => NewType.Kind == EngineTokenKind.Subscription;

    public bool ShowsSignIn => signIn is not null && TakesSetupToken;

    public bool CanSignIn => ShowsSignIn && Idle && !string.IsNullOrWhiteSpace(NewName) && !NameTaken;

    public string PasteHint => !TakesSetupToken
        ? "Paste the API key. It is billed per token, so give it a place low in the rotation."
        : signIn is null
            ? "Run claude setup-token in a terminal, signed in as the new account, then paste what it prints."
            : "Or run claude setup-token in a terminal and paste what it prints.";

    /// <summary>The API would replace that token without a word, which is what Replace token is for.</summary>
    public bool NameTaken => _tokens.Any(token => token.Name == NewName?.Trim());

    public bool CanSaveNew => Idle && !string.IsNullOrWhiteSpace(NewName) && !string.IsNullOrWhiteSpace(NewToken) && !NameTaken;

    public async Task ReadAsync(CancellationToken cancellationToken)
    {
        try
        {
            var tokens = await sdk().EngineTokens.ListEngineTokensAsync(cancellationToken);
            var limits = await sdk().EngineTokens.ListEngineLimitsAsync(cancellationToken);
            Draw(tokens, limits, DateTimeOffset.Now);
        }
        catch (HttpRequestException failure)
        {
            Error = $"Cannot load the accounts: {ApiError.Reason(failure)}";
        }
    }

    private void Draw(List<EngineTokenSummary> tokens, List<EngineLimit> limits, DateTimeOffset now)
    {
        _tokens = tokens;
        OnPropertyChanged(nameof(NameTaken));
        OnPropertyChanged(nameof(CanSaveNew));

        var rotation = AccountRules.RotationOf(tokens);
        var codexRotation = AccountRules.RotationOf(tokens, EngineTokenProvider.Openai);
        var next = AccountRules.Next(rotation, limits, now);
        (Headline, Detail) = AccountRules.Summary(next, now);

        string? Limit(string account) => AccountRules.LimitOn(account, limits, now) is { } limit ? AccountRules.DescribeLimit(limit, now) : null;
        AccountRow Row(EngineTokenSummary token, IReadOnlyList<EngineTokenSummary>? order)
        {
            var index = order is null ? -1 : order.ToList().IndexOf(token);
            var first = order is null ? null : AccountRules.Next(order, limits, now);
            var isNext = first is { Limit: null } && first.Name == token.Name;
            var join = AccountRules.LastPriority(AccountRules.RotationOf(tokens, token.Provider));
            return new AccountRow(
                token,
                isNext,
                Limit(token.Name),
                join,
                order is null ? [] : AccountRules.MovedPriorities(order, index, -1),
                order is null ? [] : AccountRules.MovedPriorities(order, index, 1),
                this);
        }

        Replace(Rotation, rotation.Select(token => Row(token, rotation)));
        Replace(CodexRotation, codexRotation.Select(token => Row(token, codexRotation)));
        Replace(Outside, AccountRules.OutsideRotation(tokens).Select(token => Row(token, null)));
        HasRotation = Rotation.Count > 0;
        HasCodexRotation = CodexRotation.Count > 0;
        HasOutside = Outside.Count > 0;

        var saved = tokens.Select(token => token.Name).ToHashSet();
        machine.Limit = Limit(AccountRules.LocalAccount);
        machine.Unused = HasRotation;
        var others = limits
            .Select(limit => limit.Account)
            .Distinct()
            .Where(account => account != AccountRules.LocalAccount && !saved.Contains(account))
            .Select(account => (account, limit: Limit(account)))
            .Where(each => each.limit is not null)
            .Select(each => $"{AccountRules.DescribeSignIn(each.account)}: {each.limit}");
        machine.OtherLimits = string.Join("\n", others) is { Length: > 0 } text ? text : null;
    }

    private static void Replace(ObservableCollection<AccountRow> rows, IEnumerable<AccountRow> drawn)
    {
        rows.Clear();
        foreach (var row in drawn)
        {
            rows.Add(row);
        }
    }

    /// <summary>Send a change and draw what the server then holds. A refusal is the caller's to show, where it is about.</summary>
    public async Task WriteAsync(Func<WilsonSdk, Task> write)
    {
        await write(sdk());
        await ReadAsync(CancellationToken.None);
    }

    /// <summary>One request per changed priority, so a failure can leave the order part moved. Reading it back shows where it stopped.</summary>
    public async Task MoveAsync(IReadOnlyList<PriorityChange> changes)
    {
        ArgumentNullException.ThrowIfNull(changes);

        Idle = false;
        Error = null;
        try
        {
            foreach (var change in changes)
            {
                await sdk().EngineTokens.UpdateEngineTokenAsync(change.Name, new UpdateEngineTokenRequest { Priority = change.Priority });
            }
        }
        catch (HttpRequestException failure)
        {
            Error = ApiError.Reason(failure);
        }

        await ReadAsync(CancellationToken.None);
        Idle = true;
    }

    [RelayCommand]
    private void AskAdd()
    {
        NewName = AccountRules.SuggestedName(_tokens);
        Adding = true;
    }

    /// <summary>Make a token by signing in, and save it as if it had been pasted. It stays in the hidden box when that is refused, so a better name can be tried.</summary>
    [RelayCommand]
    private async Task SignInAsync()
    {
        using var stop = new CancellationTokenSource();
        _signInStop = stop;
        Idle = false;
        SigningIn = true;
        SignInLink = null;
        AddError = null;
        ClaudeSignInResult? result = null;
        try
        {
            result = await signIn!.RunAsync(new Progress<string>(link => SignInLink = link), stop.Token);
        }
        catch (OperationCanceledException)
        {
            // Stopped by the person, who needs no telling.
        }

        _signInStop = null;
        SigningIn = false;
        Idle = true;
        if (result is { Token: { } token })
        {
            NewToken = token;
            await SaveNewAsync();
        }
        else
        {
            AddError = result?.Advice;
        }
    }

    [RelayCommand]
    private void StopSignIn() => _signInStop?.Cancel();

    [RelayCommand]
    private void CancelAdd()
    {
        NewName = null;
        NewToken = null;
        NewType = AccountRules.Types[0];
        JoinRotation = true;
        AddError = null;
        Adding = false;
    }

    [RelayCommand]
    private async Task SaveNewAsync()
    {
        Idle = false;
        AddError = null;
        try
        {
            var joining = JoinRotation;
            var type = NewType;
            await WriteAsync(client => client.EngineTokens.PutEngineTokenAsync(NewName!.Trim(), new PutEngineTokenRequest
            {
                Token = NewToken!,
                Provider = type.Provider,
                Kind = type.Kind,
                Pooled = joining ? true : null,
                Priority = joining ? AccountRules.LastPriority(AccountRules.RotationOf(_tokens, type.Provider)) : null,
            }));
            CancelAdd();
        }
        catch (HttpRequestException failure)
        {
            AddError = ApiError.Reason(failure);
        }

        Idle = true;
    }
}

/// <summary>`ChatEngineControl`: a draft and a Save, so typing a model name sends nothing until it is saved.</summary>
public sealed partial class ChatEngineControl(Func<WilsonSdk> sdk) : ObservableObject
{
    public IReadOnlyList<ChatEngineSettingProvider> Providers { get; } = [ChatEngineSettingProvider.Anthropic, ChatEngineSettingProvider.Openai, ChatEngineSettingProvider.Xai];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Dirty))]
    [NotifyPropertyChangedFor(nameof(Loaded))]
    private ChatEngineSetting? _stored;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Dirty))]
    [NotifyPropertyChangedFor(nameof(UsesCli))]
    [NotifyPropertyChangedFor(nameof(UsesApi))]
    [NotifyPropertyChangedFor(nameof(Hint))]
    private ChatEngineSettingEngine _engine;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Dirty))]
    private ChatEngineSettingProvider _provider;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Dirty))]
    private string? _model;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Dirty))]
    private bool _idle = true;

    [ObservableProperty]
    private string? _error;

    public bool Loaded => Stored is not null;

    public string Hint => SettingsRules.ChatEngineHint(Engine);

    public bool UsesCli
    {
        get => Engine == ChatEngineSettingEngine.Cli;
        set
        {
            if (value)
            {
                Engine = ChatEngineSettingEngine.Cli;
            }
        }
    }

    public bool UsesApi
    {
        get => Engine == ChatEngineSettingEngine.Api;
        set
        {
            if (value)
            {
                Engine = ChatEngineSettingEngine.Api;
            }
        }
    }

    public bool Dirty => Idle && Stored is { } stored && (stored.Engine != Engine || stored.Provider != Provider || stored.Model != Model);

    public async Task ReadAsync(CancellationToken cancellationToken)
    {
        try
        {
            Draw(await sdk().Settings.GetChatEngineSettingAsync(cancellationToken));
        }
        catch (HttpRequestException failure)
        {
            Error = $"Cannot load the chat engine: {ApiError.Reason(failure)}";
        }
    }

    [RelayCommand]
    public async Task SaveAsync()
    {
        if (!Dirty)
        {
            return;
        }

        Idle = false;
        Error = null;
        try
        {
            Draw(await sdk().Settings.SetChatEngineSettingAsync(new ChatEngineSetting { Engine = Engine, Provider = Provider, Model = Model ?? string.Empty }));
        }
        catch (HttpRequestException failure)
        {
            Error = ApiError.Reason(failure);
        }

        Idle = true;
    }

    private void Draw(ChatEngineSetting setting)
    {
        Stored = setting;
        Engine = setting.Engine;
        Provider = setting.Provider;
        Model = setting.Model;
    }
}

/// <summary>`StageRoutingRow`: one lane's engine, provider and model, a draft saved on its own. It shows what the server kept, never only what was picked.</summary>
public sealed partial class StageRoutingRow(StageRouting route, StageRoutingControl control) : ObservableObject
{
    public IReadOnlyList<StageRoutingProvider> Providers { get; } = [StageRoutingProvider.Anthropic, StageRoutingProvider.Openai, StageRoutingProvider.Xai];

    public string Stage { get; } = route.Stage;

    public bool ChoosesAdapter { get; } = SettingsRules.ChoosesAdapter(route.Stage);

    public string? Placeholder { get; } = SettingsRules.ModelPlaceholder(route.Stage);

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSave))]
    private StageRouting _stored = route;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSave))]
    [NotifyPropertyChangedFor(nameof(UsesCli))]
    [NotifyPropertyChangedFor(nameof(UsesApi))]
    [NotifyPropertyChangedFor(nameof(UsesCodex))]
    [NotifyPropertyChangedFor(nameof(ChoosesProvider))]
    private StageRoutingAdapter _adapter = route.Adapter;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSave))]
    private StageRoutingProvider _provider = route.Provider;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSave))]
    private string? _model = route.Model;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSave))]
    private bool _idle = true;

    [ObservableProperty]
    private string? _error;

    public bool ChoosesProvider => SettingsRules.ChoosesProvider(Stage, Adapter);

    public bool UsesCli
    {
        get => Adapter == StageRoutingAdapter.Cli;
        set
        {
            if (value)
            {
                Adapter = StageRoutingAdapter.Cli;
            }
        }
    }

    public bool UsesApi
    {
        get => Adapter == StageRoutingAdapter.Api;
        set
        {
            if (value)
            {
                Adapter = StageRoutingAdapter.Api;
            }
        }
    }

    public bool UsesCodex
    {
        get => Adapter == StageRoutingAdapter.Codex;
        set
        {
            if (value)
            {
                Adapter = StageRoutingAdapter.Codex;
            }
        }
    }

    public bool CanSave => Idle
        && !string.IsNullOrWhiteSpace(Model)
        && (Stored.Adapter != Adapter || Stored.Provider != Provider || (Stored.Model ?? string.Empty) != Model)
        && SettingsRules.RoutingRequest(Adapter, Provider, Model) is not null;

    [RelayCommand]
    public async Task SaveAsync()
    {
        if (!CanSave)
        {
            return;
        }

        Idle = false;
        Error = null;
        try
        {
            var saved = await control.Sdk().Stages.SetStageRoutingAsync(Stage, SettingsRules.RoutingRequest(Adapter, Provider, Model!)!);
            Stored = saved;
            Adapter = saved.Adapter;
            Provider = saved.Provider;
            Model = saved.Model;
            control.RouteChanged();
        }
        catch (HttpRequestException failure)
        {
            Error = ApiError.Reason(failure);
        }

        Idle = true;
    }

    partial void OnAdapterChanged(StageRoutingAdapter value) => Provider = SettingsRules.ProviderOn(value, Provider);
}

/// <summary>`StageRoutingControl`: which engine, provider and model each lane runs on.</summary>
public sealed partial class StageRoutingControl(Func<WilsonSdk> sdk) : ObservableObject
{
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(SharedProvider))]
    private IReadOnlyList<StageRoutingRow> _rows = [];

    [ObservableProperty]
    private string? _error;

    public string? SharedProvider => SettingsRules.SharedProvider(Rows.Select(row => row.Stored));

    internal Func<WilsonSdk> Sdk => sdk;

    public async Task ReadAsync(CancellationToken cancellationToken)
    {
        try
        {
            var routes = await sdk().Stages.ListStageRoutingAsync(cancellationToken);
            Rows = [.. SettingsRules.RoutedLanes(routes).Select(route => new StageRoutingRow(route, this))];
            Error = null;
        }
        catch (HttpRequestException failure)
        {
            Error = $"Cannot load stage routing: {ApiError.Reason(failure)}";
        }
    }

    internal void RouteChanged() => OnPropertyChanged(nameof(SharedProvider));
}

/// <summary>A second factor, as drawn.</summary>
public sealed record FactorRow(string Id, string Name, SecurityControl Control);

/// <summary>
/// `SecurityControls.tsx`. Adding or removing a factor can meet the step-up, which `SessionHandler` handles
/// under the request. A passkey is only listed and removed here: an app signed ad hoc cannot make one, so
/// adding one opens the web app.
/// </summary>
public sealed partial class SecurityControl(ShellViewModel shell) : ObservableObject
{
    private AuthenticatorRegistration? _registration;

    public ObservableCollection<FactorRow> Factors { get; } = [];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSetUp))]
    private bool _hasAuthenticator;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSetUp))]
    [NotifyPropertyChangedFor(nameof(Idle))]
    private bool _busy;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSetUp))]
    [NotifyPropertyChangedFor(nameof(NotEnrolling))]
    private bool _enrolling;

    [ObservableProperty]
    private Bitmap? _qrCode;

    [ObservableProperty]
    private string? _secret;

    [ObservableProperty]
    private string? _code;

    [ObservableProperty]
    private string? _error;

    public bool Idle => !Busy;

    public bool NotEnrolling => !Enrolling;

    public bool CanSetUp => !Busy && !Enrolling && !HasAuthenticator;

    public async Task ReadAsync(CancellationToken cancellationToken)
    {
        try
        {
            var factors = await shell.Connection!.Sdk.Factors.ListSecondFactorsAsync(cancellationToken);
            Factors.Clear();
            foreach (var factor in factors)
            {
                var kind = factor.Method == SecondFactorMethod.Passkey ? "Passkey" : "Authenticator app";
                Factors.Add(new FactorRow(factor.Id, factor.Label is { Length: > 0 } label ? $"{kind} ({label})" : kind, this));
            }

            HasAuthenticator = factors.Any(factor => factor.Method == SecondFactorMethod.Authenticator);
        }
        catch (HttpRequestException failure)
        {
            Error = $"Cannot load your second factors: {ApiError.Reason(failure)}";
        }
    }

    [RelayCommand]
    public async Task StartAsync()
    {
        Busy = true;
        Error = null;
        try
        {
            _registration = await shell.Connection!.Sdk.Factors.StartAuthenticatorAsync(new StartAuthenticatorRequest { Label = "wilson" });
            Secret = _registration.Secret;
            QrCode = DataUrl.Bytes(_registration.QrCode) is { } png ? new Bitmap(new MemoryStream(png)) : null;
            Enrolling = true;
        }
        catch (HttpRequestException failure)
        {
            Error = ApiError.Reason(failure);
        }

        Busy = false;
    }

    [RelayCommand]
    public async Task VerifyAsync()
    {
        if (_registration is not { } registration)
        {
            return;
        }

        Busy = true;
        Error = null;
        try
        {
            await shell.Connection!.Sdk.Factors.VerifyAuthenticatorAsync(new VerifyAuthenticatorRequest { RegistrationId = registration.RegistrationId, Code = Code?.Trim() ?? string.Empty });
            CancelEnrolling();
            await ReadAsync(CancellationToken.None);
        }
        catch (HttpRequestException failure)
        {
            Error = SignInWords.OfCode(failure);
        }

        Busy = false;
    }

    [RelayCommand]
    public void CancelEnrolling()
    {
        Enrolling = false;
        _registration = null;
        Secret = null;
        Code = null;
        QrCode = null;
    }

    [RelayCommand]
    public async Task RemoveAsync(FactorRow row)
    {
        ArgumentNullException.ThrowIfNull(row);

        Busy = true;
        Error = null;
        try
        {
            await shell.Connection!.Sdk.Factors.RemoveSecondFactorAsync(row.Id);
            await ReadAsync(CancellationToken.None);
        }
        catch (HttpRequestException failure)
        {
            Error = ApiError.Reason(failure);
        }

        Busy = false;
    }

    /// <summary>Settings in the web app, on the same server.</summary>
    [RelayCommand]
    public void AddPasskey()
    {
        try
        {
            using var opened = Process.Start(new ProcessStartInfo("open") { ArgumentList = { $"{shell.Connection!.Origin}/settings" } });
        }
        catch (System.ComponentModel.Win32Exception failure)
        {
            Error = failure.Message;
        }
    }
}
