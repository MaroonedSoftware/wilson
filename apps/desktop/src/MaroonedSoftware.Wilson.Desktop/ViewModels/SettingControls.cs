using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Desktop.Core.Runner;

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
