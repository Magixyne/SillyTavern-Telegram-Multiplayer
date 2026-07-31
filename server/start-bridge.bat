@echo off
chcp 65001 >nul
title Telegram MultiPlayer Bridge (防睡眠)
echo ================================================
echo   Telegram MultiPlayer Bridge 启动器
echo   运行期间临时禁用系统睡眠, 退出后自动恢复
echo ================================================
echo.

REM 临时禁用睡眠 (交流电 + 电池), 防止电脑睡眠中断 Bridge
powercfg /change standby-timeout-ac 0 >nul 2>&1
powercfg /change standby-timeout-dc 0 >nul 2>&1
if %errorlevel%==0 (
    echo [√] 已临时禁用系统睡眠 (需要管理员权限时请右键"以管理员身份运行")
) else (
    echo [!] 无法修改电源设置, 请尝试右键"以管理员身份运行"本脚本
)
echo.

echo 启动 Bridge... (按 Ctrl+C 停止)
echo ------------------------------------------------
node server.js
echo ------------------------------------------------
echo.

REM 恢复默认睡眠设置 (交流 30 分钟 / 电池 15 分钟)
powercfg /change standby-timeout-ac 30 >nul 2>&1
powercfg /change standby-timeout-dc 15 >nul 2>&1
echo [√] 已恢复系统睡眠设置
pause
