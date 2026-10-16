use std::{env, fs};
use zed_extension_api::{self as zed, settings::LspSettings, LanguageServerId, Result};

const SERVER_PACKAGE: &str = "@lucidcms/kiln-language-server";
const SERVER_PATH: &str = "node_modules/@lucidcms/kiln-language-server/dist/main.js";

/// Starts Kiln's language server, installing it from npm into the extension's folder when the project doesn't have its own.
struct KilnExtension {
    installed: bool,
}

impl KilnExtension {
    fn server_exists(&self) -> bool {
        fs::metadata(SERVER_PATH).is_ok_and(|stat| stat.is_file())
    }

    /// Installs the latest server from npm, or updates it, and returns its path relative to the extension's folder.
    fn install_server(&mut self, id: &LanguageServerId) -> Result<String> {
        if self.installed && self.server_exists() {
            return Ok(SERVER_PATH.to_string());
        }
        zed::set_language_server_installation_status(
            id,
            &zed::LanguageServerInstallationStatus::CheckingForUpdate,
        );
        let latest = zed::npm_package_latest_version(SERVER_PACKAGE);
        let installed = zed::npm_package_installed_version(SERVER_PACKAGE)?;
        match latest {
            Ok(version) if installed.as_ref() != Some(&version) || !self.server_exists() => {
                zed::set_language_server_installation_status(
                    id,
                    &zed::LanguageServerInstallationStatus::Downloading,
                );
                // Offline, an older copy is better than none.
                if let Err(error) = zed::npm_install_package(SERVER_PACKAGE, &version) {
                    if !self.server_exists() {
                        return Err(error);
                    }
                }
            }
            Err(error) if !self.server_exists() => return Err(error),
            _ => {}
        }
        if !self.server_exists() {
            return Err(format!("{SERVER_PACKAGE} did not install {SERVER_PATH}"));
        }
        self.installed = true;
        Ok(SERVER_PATH.to_string())
    }
}

impl zed::Extension for KilnExtension {
    fn new() -> Self {
        Self { installed: false }
    }

    fn language_server_command(
        &mut self,
        id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        // A command in the user's settings wins, for trying a local build of the server.
        let binary = LspSettings::for_worktree(id.as_ref(), worktree)
            .ok()
            .and_then(|settings| settings.binary);
        if let Some(path) = binary.as_ref().and_then(|binary| binary.path.clone()) {
            return Ok(zed::Command {
                command: path,
                args: binary
                    .and_then(|binary| binary.arguments)
                    .unwrap_or_else(|| vec!["--stdio".to_string()]),
                env: Default::default(),
            });
        }

        // Then the project's own copy, so it matches the project's version of Kiln.
        let script = if worktree
            .read_text_file("node_modules/@lucidcms/kiln-language-server/package.json")
            .is_ok()
        {
            format!("{}/{SERVER_PATH}", worktree.root_path())
        } else {
            let path = self.install_server(id)?;
            env::current_dir()
                .map_err(|error| error.to_string())?
                .join(path)
                .to_string_lossy()
                .to_string()
        };
        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![script, "--stdio".to_string()],
            env: Default::default(),
        })
    }
}

zed::register_extension!(KilnExtension);
