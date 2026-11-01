using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MaroonedSoftware.Wilson.Desktop.Core.Auth;
using MaroonedSoftware.Wilson.Sdk.Models;

namespace MaroonedSoftware.Wilson.Desktop.ViewModels;

/// <summary>A new card when the id is null, otherwise that card's title and body.</summary>
public sealed partial class CardFormViewModel(ShellViewModel shell, string project, string? id) : PageViewModel
{
    private CardDetail? _original;

    public ShellViewModel Shell => shell;

    public string Heading => id is null ? "New card" : $"Edit {id}";

    [ObservableProperty]
    private string? _title;

    [ObservableProperty]
    private string? _body;

    [ObservableProperty]
    private bool _busy;

    [ObservableProperty]
    private string? _error;

    [RelayCommand]
    public async Task SaveAsync()
    {
        if (string.IsNullOrWhiteSpace(Title))
        {
            Error = "A card needs a title.";
            return;
        }

        Busy = true;
        Error = null;
        try
        {
            using var sdk = shell.Connection!.ForProject(project);
            var title = Title.Trim();
            var body = Body ?? string.Empty;
            if (id is null)
            {
                await sdk.Board.CreateCardAsync(new CreateCardRequest { Title = title, Body = body });
            }
            else
            {
                // Each is its own guarded write, so an unchanged half is not sent to be refused.
                if (title != _original?.Title)
                {
                    await sdk.Board.RenameCardAsync(id, new RenameCardRequest { Title = title });
                }

                if (body != _original?.Body)
                {
                    await sdk.Board.EditCardBodyAsync(id, new EditCardRequest { Body = body });
                }
            }

            shell.Back();
        }
        catch (HttpRequestException failure)
        {
            Error = ApiError.Reason(failure);
        }
        finally
        {
            Busy = false;
        }
    }

    protected override async Task OnShownAsync(CancellationToken cancellationToken)
    {
        if (id is null || _original is not null)
        {
            return;
        }

        try
        {
            using var sdk = shell.Connection!.ForProject(project);
            _original = await sdk.Board.GetCardAsync(id, cancellationToken);
            Title = _original.Title;
            Body = _original.Body;
        }
        catch (HttpRequestException failure)
        {
            Error = ApiError.Reason(failure);
        }
    }
}
