import * as vscode from 'vscode';
import { TestAdapter, TestLoadStartedEvent, TestLoadFinishedEvent, TestRunStartedEvent, TestRunFinishedEvent, TestSuiteEvent, TestEvent, TestSuiteInfo, RetireEvent } from 'vscode-test-adapter-api';
import { Log } from 'vscode-test-adapter-util';

import * as child_process from 'child_process';
import * as readline from 'readline';
import { existsSync } from 'fs';

export class FangLuaTestingAdapter implements TestAdapter {

	private disposables: { dispose(): void }[] = [];

	private readonly testsEmitter = new vscode.EventEmitter<TestLoadStartedEvent | TestLoadFinishedEvent>();
	private readonly testStatesEmitter = new vscode.EventEmitter<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent>();
	private readonly retireEmitter = new vscode.EventEmitter<RetireEvent>();

	private runningTestProcess: child_process.ChildProcess | undefined;

	private suiteData: string = "";

	get tests(): vscode.Event<TestLoadStartedEvent | TestLoadFinishedEvent> { return this.testsEmitter.event; }
	get testStates(): vscode.Event<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent> { return this.testStatesEmitter.event; }
	get retire(): vscode.Event<RetireEvent> | undefined { return this.retireEmitter.event; }

	constructor(
		public readonly workspace: vscode.WorkspaceFolder,
		private readonly log: Log
	) {
		this.log.info('Initializing fang lua test adapter');
		this.disposables.push(this.testsEmitter);
		this.disposables.push(this.testStatesEmitter);
		this.disposables.push(this.retireEmitter);

		vscode.workspace.onDidChangeConfiguration(configChange => {
			if (configChange.affectsConfiguration('fangluatesting.luaexecutatble')) {
				this.load();
			}
		});

		vscode.workspace.onDidSaveTextDocument(document => {
			if (document.uri.toString().endsWith("_test.lua")) {
				this.load();
			} else {  //if (isApplicationFile(document.uri)) {
				this.retireEmitter.fire({});
			}
		});
	}

	show_error(message: string): void {
		vscode.window.showErrorMessage("Fang lua test adapter error:\n" + message)
	}

	async spawn_fang(mode: string, tests: string[], onStdOut: (o: string) => void, onFinish: (error: string) => void): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const lua_executable = <string>vscode.workspace.getConfiguration("fangluatesting", null).get("luaexecutatble");

			var path = this.workspace.uri.path.normalize()
			if (!path.startsWith('/')) {
				path = path.substring(1)
			}

			if (!existsSync(path + '/fang/fang-runner.lua')) {
				onFinish("Fang not initialized!")
				return;
			}

			const call = [path + '/fang/fang-runner.lua'].concat([mode]).concat([path]).concat(tests).concat(['--vscode'])

			const cspr = child_process.spawn(lua_executable, call, { cwd: path });
			this.runningTestProcess = cspr

			const rl = readline.createInterface({ input: cspr.stdout });
			rl.on('line', (line: string) => {
				onStdOut(line)
			})

			var standard_error_out = ''
			cspr.stderr?.on('data', (data) => {
				standard_error_out += `${data}`
			});

			cspr.on('error', (err) => {
				this.runningTestProcess = undefined
				this.show_error(`Failed to start subprocess. ${err}`);
				onFinish(`Failed to start subprocess. ${err}`)
				reject()
			});

			cspr.once('exit', () => {
				this.runningTestProcess = undefined;
				if (standard_error_out != '') {
					this.show_error(standard_error_out)
				}
				onFinish(standard_error_out)
				resolve();
			});
		});
	}

	private is_loading: boolean = false;

	async load(): Promise<void> {
		if (this.is_loading) return
		this.is_loading = true

		this.log.info('Loading lua tests');

		this.testsEmitter.fire({ type: 'started' });
		this.suiteData = ""

		return this.spawn_fang('suite', [], (o: string) => {
			this.suiteData += o.trim()
		}, (errorMessage: string) => {
			if (errorMessage != '')
				this.testsEmitter.fire({ type: 'finished', errorMessage });
			else if (this.suiteData != '') {
				try {
					const suite = <TestSuiteInfo>JSON.parse(this.suiteData)
					if ('children' in suite)
						this.testsEmitter.fire({ type: 'finished', suite });
					else
						this.testsEmitter.fire({ type: 'finished', errorMessage: 'No tests found' });
				} catch (e) {
					errorMessage = "Failed to parse test suit information."
					this.show_error(errorMessage)
					this.testsEmitter.fire({ type: 'finished', errorMessage });
				}
			} else
				this.testsEmitter.fire({ type: 'finished', errorMessage: 'No tests found' });

			this.retireEmitter.fire({ tests: ['root'] });
			this.is_loading = false;
		});
	}

	private is_running = false;
	async run(tests: string[]): Promise<void> {
		if (this.is_running) return
		this.is_running = true;

		this.log.info(`Running lua tests ${JSON.stringify(tests)}`);
		this.testStatesEmitter.fire({ type: 'started', tests });

		return this.spawn_fang('run', tests, (o: string) => {
			try {
				for (const l of o.split(/\r?\n/)) {
					this.testStatesEmitter.fire(JSON.parse(l))
				}
			} catch (e) {
				this.show_error("Failed to parse test run information. " + e.toString())
			}
		}, () => {
			this.testStatesEmitter.fire({ type: 'finished' });
			this.is_running = false;
		});
	}

	/*	implement this method if your TestAdapter supports debugging tests
		async debug(tests: string[]): Promise<void> {
			// start a test run in a child process and attach the debugger to it...
		}
	*/

	cancel(): void {
		if (this.runningTestProcess) {
			const ok = this.runningTestProcess.kill();
			console.log(`killed ${ok}`);
			this.runningTestProcess = undefined;
		}
	}

	dispose(): void {
		this.cancel();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables = [];
	}
}
