using System.Collections.ObjectModel;
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

/// <summary>`EngineTokenControl`. Write-only: the API reports where the sign-in comes from and never the token, so the box starts empty and is emptied by a save.</summary>
public sealed partial class EngineTokenControl(Func<WilsonSdk> sdk) : ObservableObject
{
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSave))]
    private string? _draft;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Source))]
    [NotifyPropertyChangedFor(nameof(CanRemove))]
    private EngineTokenSetting? _setting;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSave))]
    [NotifyPropertyChangedFor(nameof(CanRemove))]
    private bool _idle = true;

    [ObservableProperty]
    private string? _error;

    public string? Source => Setting is { } setting ? SettingsRules.EngineTokenSource(setting.Source) : null;

    public bool CanSave => Idle && !string.IsNullOrWhiteSpace(Draft);

    public bool CanRemove => Idle && Setting?.Source == EngineTokenSettingSource.Database;

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
        }
        catch (HttpRequestException failure)
        {
            Error = ApiError.Reason(failure);
        }

        Idle = true;
    }
}

/// <summary>A worker's engine token, as drawn: its name and the hosts using it, never the token.</summary>
public sealed record EngineTokenRow(string Name, string Hosts, WorkerTokensControl Control);

/// <summary>`WorkerEngineTokensControl`. Saving under a name already there replaces that token and no other.</summary>
public sealed partial class WorkerTokensControl(Func<WilsonSdk> sdk) : ObservableObject
{
    public ObservableCollection<EngineTokenRow> Tokens { get; } = [];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSave))]
    private string? _name;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSave))]
    private string? _token;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSave))]
    private bool _idle = true;

    [ObservableProperty]
    private string? _error;

    public bool CanSave => Idle && !string.IsNullOrWhiteSpace(Name) && !string.IsNullOrWhiteSpace(Token);

    public async Task ReadAsync(CancellationToken cancellationToken)
    {
        try
        {
            var tokens = await sdk().EngineTokens.ListEngineTokensAsync(cancellationToken);
            Tokens.Clear();
            foreach (var token in tokens)
            {
                Tokens.Add(new EngineTokenRow(token.Name, token.Hosts.Count > 0 ? string.Join(", ", token.Hosts) : "no host", this));
            }
        }
        catch (HttpRequestException failure)
        {
            Error = $"Cannot load the worker engine tokens: {ApiError.Reason(failure)}";
        }
    }

    [RelayCommand]
    public Task SaveAsync() => WriteAsync(async client =>
    {
        await client.EngineTokens.PutEngineTokenAsync(Name!.Trim(), new PutEngineTokenRequest { Token = Token! });
        Name = null;
        Token = null;
    });

    [RelayCommand]
    public Task RemoveAsync(EngineTokenRow row)
    {
        ArgumentNullException.ThrowIfNull(row);

        return WriteAsync(client => client.EngineTokens.RemoveEngineTokenAsync(row.Name));
    }

    private async Task WriteAsync(Func<WilsonSdk, Task> write)
    {
        Idle = false;
        Error = null;
        try
        {
            await write(sdk());
            await ReadAsync(CancellationToken.None);
        }
        catch (HttpRequestException failure)
        {
            Error = ApiError.Reason(failure);
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
