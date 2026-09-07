const AUTOSTART_ARGUMENT: &str = "--piabyss-autostart";

pub fn was_launched_at_login() -> bool {
    std::env::args_os().any(|argument| argument == AUTOSTART_ARGUMENT)
}

#[cfg(target_os = "windows")]
pub fn configure(enabled: bool) -> Result<(), String> {
    windows::configure(enabled)
}

#[cfg(not(target_os = "windows"))]
pub fn configure(enabled: bool) -> Result<(), String> {
    if enabled {
        Err("launch at startup is currently supported only on Windows".to_string())
    } else {
        Ok(())
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use super::AUTOSTART_ARGUMENT;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{
        ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS,
    };
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegOpenKeyExW, RegSetValueExW, HKEY,
        HKEY_CURRENT_USER, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ,
    };

    const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const VALUE_NAME: &str = "PiAbyss";

    struct RegistryKey(HKEY);

    impl Drop for RegistryKey {
        fn drop(&mut self) {
            unsafe {
                RegCloseKey(self.0);
            }
        }
    }

    pub fn configure(enabled: bool) -> Result<(), String> {
        if enabled {
            enable()
        } else {
            disable()
        }
    }

    fn enable() -> Result<(), String> {
        let executable = std::env::current_exe()
            .map_err(|error| format!("could not resolve the PiAbyss executable: {error}"))?;
        let command = startup_command(&executable)?;
        let key_path = wide(RUN_KEY);
        let value_name = wide(VALUE_NAME);
        let value = wide(&command);
        let mut raw_key: HKEY = null_mut();
        let result = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                key_path.as_ptr(),
                0,
                null(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE,
                null(),
                &mut raw_key,
                null_mut(),
            )
        };
        if result != ERROR_SUCCESS {
            return Err(windows_error(
                "could not open the Windows startup registry key",
                result,
            ));
        }
        let key = RegistryKey(raw_key);
        let byte_len = value
            .len()
            .checked_mul(std::mem::size_of::<u16>())
            .and_then(|length| u32::try_from(length).ok())
            .ok_or_else(|| "the Windows startup command is too long".to_string())?;
        let result = unsafe {
            RegSetValueExW(
                key.0,
                value_name.as_ptr(),
                0,
                REG_SZ,
                value.as_ptr().cast(),
                byte_len,
            )
        };
        if result != ERROR_SUCCESS {
            return Err(windows_error(
                "could not register PiAbyss for startup",
                result,
            ));
        }
        Ok(())
    }

    fn disable() -> Result<(), String> {
        let key_path = wide(RUN_KEY);
        let value_name = wide(VALUE_NAME);
        let mut raw_key: HKEY = null_mut();
        let result = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                key_path.as_ptr(),
                0,
                KEY_SET_VALUE,
                &mut raw_key,
            )
        };
        if result == ERROR_FILE_NOT_FOUND || result == ERROR_PATH_NOT_FOUND {
            return Ok(());
        }
        if result != ERROR_SUCCESS {
            return Err(windows_error(
                "could not open the Windows startup registry key",
                result,
            ));
        }
        let key = RegistryKey(raw_key);
        let result = unsafe { RegDeleteValueW(key.0, value_name.as_ptr()) };
        if result != ERROR_SUCCESS && result != ERROR_FILE_NOT_FOUND {
            return Err(windows_error(
                "could not remove PiAbyss from startup",
                result,
            ));
        }
        Ok(())
    }

    fn startup_command(executable: &Path) -> Result<String, String> {
        let executable = executable
            .to_str()
            .ok_or_else(|| "the PiAbyss executable path is not valid Unicode".to_string())?;
        if executable.contains('"') {
            return Err("the PiAbyss executable path contains an unsupported quote".to_string());
        }
        Ok(format!(r#""{executable}" {AUTOSTART_ARGUMENT}"#))
    }

    fn wide(value: &str) -> Vec<u16> {
        std::ffi::OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn windows_error(context: &str, code: u32) -> String {
        format!(
            "{context}: {} (Windows error {code})",
            std::io::Error::from_raw_os_error(code as i32)
        )
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn startup_command_quotes_the_executable_and_adds_the_hidden_argument() {
            assert_eq!(
                startup_command(Path::new(r"C:\Program Files\PiAbyss\PiAbyss.exe")).unwrap(),
                r#""C:\Program Files\PiAbyss\PiAbyss.exe" --piabyss-autostart"#
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_argument_is_stable() {
        assert_eq!(AUTOSTART_ARGUMENT, "--piabyss-autostart");
    }
}
