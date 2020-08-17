import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

//#region Utilities

namespace _ {

	function handleResult<T>(resolve: (result: T) => void, reject: (error: Error) => void, error: Error | null | undefined, result: T): void {
		if (error) {
			reject(massageError(error));
		} else {
			resolve(result);
		}
	}

	function massageError(error: Error & { code?: string }): Error {
		if (error.code === 'ENOENT') {
			return vscode.FileSystemError.FileNotFound();
		}

		if (error.code === 'EISDIR') {
			return vscode.FileSystemError.FileIsADirectory();
		}

		if (error.code === 'EEXIST') {
			return vscode.FileSystemError.FileExists();
		}

		if (error.code === 'EPERM' || error.code === 'EACCESS') {
			return vscode.FileSystemError.NoPermissions();
		}

		return error;
	}

	export function normalizeNFC(items: string): string;
	export function normalizeNFC(items: string[]): string[];
	export function normalizeNFC(items: string | string[]): string | string[] {
		if (process.platform !== 'darwin') {
			return items;
		}

		if (Array.isArray(items)) {
			return items.map(item => item.normalize('NFC'));
		}

		return items.normalize('NFC');
	}

	export function readdir(path: string): Promise<string[]> {
		return new Promise<string[]>((resolve, reject) => {
			fs.readdir(path, (error, children) => handleResult(resolve, reject, error, normalizeNFC(children)));
		});
	}

	export function stat(path: string): Promise<fs.Stats> {
		return new Promise<fs.Stats>((resolve, reject) => {
			fs.stat(path, (error, stat) => handleResult(resolve, reject, error, stat));
		});
	}

}

export class FileStat implements vscode.FileStat {

	constructor(private fsStat: fs.Stats) { }

	get type(): vscode.FileType {
		return this.fsStat.isFile() ? vscode.FileType.File : this.fsStat.isDirectory() ? vscode.FileType.Directory : this.fsStat.isSymbolicLink() ? vscode.FileType.SymbolicLink : vscode.FileType.Unknown;
	}

	get isFile(): boolean | undefined {
		return this.fsStat.isFile();
	}

	get isDirectory(): boolean | undefined {
		return this.fsStat.isDirectory();
	}

	get isSymbolicLink(): boolean | undefined {
		return this.fsStat.isSymbolicLink();
	}

	get size(): number {
		return this.fsStat.size;
	}

	get ctime(): number {
		return this.fsStat.ctime.getTime();
	}

	get mtime(): number {
		return this.fsStat.mtime.getTime();
	}
}

interface Entry {
	uri: vscode.Uri;
	type: vscode.FileType;
	stat?: vscode.FileStat;
}

enum SortBy {
    ModifiedTime = 'Modified Time',
    CreationTime = 'Creation Time',
    FileName = 'File Name',
    FileSize = 'File Size'
}

//#endregion

export class SortedFilesProvider implements vscode.TreeDataProvider<Entry> {
	private _sortedFilesView: vscode.TreeView<Entry> | undefined;

	private readonly pattern: RegExp;

	private maxItem: number;

	private sortBy = SortBy.ModifiedTime;
	private asc = -1;;

	private _watchedFolder: vscode.Uri | undefined; 

	private unwatch: vscode.Disposable | undefined;
	
	private readonly allFiles: Entry[] = [];

	private _onDidChangeTreeData: vscode.EventEmitter<Entry | undefined>;

	constructor() {
		this._onDidChangeTreeData = new vscode.EventEmitter<Entry | undefined>();
		this.pattern = new RegExp(vscode.workspace.getConfiguration("sortedFiles").get("pattern") as string);
		this.maxItem = vscode.workspace.getConfiguration("sortedFiles").get("maxItems") as number;
	}

	get onDidChangeTreeData(): vscode.Event<Entry | undefined> {
		return this._onDidChangeTreeData.event;
	}

	set watchedFolder(uri: vscode.Uri | undefined) {
		this._watchedFolder = uri;
	}

	get watchedFolder() : vscode.Uri | undefined {
		return this._watchedFolder;
	}

	set sortedFilesView(view: vscode.TreeView<Entry>) {
		this._sortedFilesView = view;
	}

	watch(uri: vscode.Uri, options: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
		if (this.unwatch) {
			this.unwatch.dispose();
		}

		const watcher = fs.watch(uri.fsPath, { recursive: options.recursive }, async (event: string, filename: string | Buffer) => {
			const filenameStr = filename.toString();

			if (this.pattern.test(filenameStr)) {
				this.refresh();
			}
		});

		this.unwatch = { dispose: () => watcher.close() };

		return this.unwatch;
	}

	stat(uri: vscode.Uri): vscode.FileStat | Thenable<vscode.FileStat> {
		return this._stat(uri.fsPath);
	}

	async _stat(path: string): Promise<vscode.FileStat> {
		return new FileStat(await _.stat(path));
	}

	readDirectory(uri: vscode.Uri): [string, vscode.FileType][] | Thenable<[string, vscode.FileType][]> {
		return this._readDirectory(uri);
	}

	async _readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		const children = await _.readdir(uri.fsPath);

		const result: [string, vscode.FileType][] = [];
		for (let i = 0; i < children.length; i++) {
			const child = children[i];
			const stat = await this._stat(path.join(uri.fsPath, child));
			result.push([child, stat.type]);
		}

		return Promise.resolve(result);
	}

	// tree data provider
	
	updateWatchedFolder(uri: vscode.Uri) {
		this._watchedFolder = uri;

		this.watch(this._watchedFolder, {recursive: true, excludes: []});

		this.setSortBy(SortBy.ModifiedTime);
	}
	
	refresh() {
		this._onDidChangeTreeData.fire(undefined);
	}

	async getChildren(element?: Entry): Promise<Entry[]> {
		
		if (element || !this._watchedFolder) {
			return Promise.resolve([]);
			// vscode.window.showInformationMessage('Sorted files folder is not set.');
		} else {
			const nestedArr = await this.getAllFiles(this._watchedFolder) as any[];
			let entryArr = nestedArr.flat(Infinity) as Entry[];

			entryArr.sort((e1, e2) => {
				if (!e1.stat || !e2.stat) {
					return 0;
				}
				let ret;				
				switch(this.sortBy) {
					case SortBy.ModifiedTime:
						ret = (e2.stat.mtime - e1.stat.mtime) * this.asc;
						break;
					case SortBy.CreationTime:
						ret = (e2.stat.ctime - e1.stat.ctime) * this.asc;
						break;
					case SortBy.FileName:
						ret = (e2.uri.fsPath.localeCompare(e1.uri.fsPath)) * this.asc;
						break;
					case SortBy.FileSize:
						ret = (e2.stat.size - e1.stat.size) * this.asc;
						break;
					default:
						ret = 0;
				}
				return ret;
			});

			if (entryArr.length > this.maxItem) {
				entryArr = entryArr.slice(0, this.maxItem);
			}

			// entryArr.forEach(entry => {
			// 	console.log('Each Entry:');
			// 	console.log(entry.uri.fsPath, entry.stat?.ctime, entry.stat?.mtime);
			// });

			return entryArr;
		}
	}
	
	async getAllFiles(uri: vscode.Uri): Promise<any[]> {
		const allFiles: Entry[] = [];
		const children = await this.readDirectory(uri);
		const filteredFiles = children
			.filter(child => child[1] === vscode.FileType.File && this.pattern.test(child[0]));
			
		for (let i = 0; i < filteredFiles.length; i++) {
			const fileuri = vscode.Uri.file(path.join(uri.fsPath, filteredFiles[i][0]));
			const filestat = await this.stat(fileuri);
			allFiles.push({uri: fileuri, type: filteredFiles[i][1], stat: filestat });
		}

		let promises: any[] = [allFiles];
		children
			.filter(child => child[1] === vscode.FileType.Directory)
			.forEach(dir => {
				promises.push(this.getAllFiles(vscode.Uri.file(path.join(uri.fsPath, dir[0]))));
			});

		return Promise.all(promises);
	}

	getTreeItem(element: Entry): vscode.TreeItem {
		// console.log('getTreeItem', element.uri.fsPath);
		
		const treeItem = new vscode.TreeItem(element.uri, element.type === vscode.FileType.Directory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
		if (element.type === vscode.FileType.File) {
			treeItem.command = { command: 'sortedFiles.openFile', title: "Open File", arguments: [element.uri], };
			treeItem.contextValue = 'file';
			treeItem.description = this.getTreeItemDescription(element.uri);
		}
		return treeItem;
	}

	getTreeItemDescription(uri: vscode.Uri): string {
		let desc = '';

		if (this._watchedFolder) {
			const folderPath = this._watchedFolder.fsPath;
			const itemPath = uri.fsPath;
			if (itemPath.indexOf(folderPath) > -1) {
				desc = itemPath.substring(folderPath.length + 1);
				desc = desc.replace(/\\\w*\.\w*$/, '');
			}
		}

		return desc;
	}

	setSortBy(sortBy: SortBy) {
		this.asc = this.sortBy === sortBy ? this.asc*(-1) : 1;
		this.sortBy = sortBy;
		if (this._sortedFilesView) {
			this._sortedFilesView.title = `Sorted Files (By ${this.sortBy})`;
		}
		this.refresh();
	}
}

export class SortedFiles {

	private treeDataProvider: SortedFilesProvider;

	constructor(context: vscode.ExtensionContext) {
		const treeDataProvider = new SortedFilesProvider();
		this.treeDataProvider = treeDataProvider;
		this.treeDataProvider.sortedFilesView = vscode.window.createTreeView('sortedFiles', { treeDataProvider });
		context.subscriptions.push(vscode.commands.registerCommand('sortedFiles.openFile', (resource) => this.openResource(resource)));
		context.subscriptions.push(vscode.commands.registerCommand('sortedFiles.openFolder', () => this.openFolder()));
		context.subscriptions.push(vscode.commands.registerCommand('sortedFiles.modifiedTime', () => this.treeDataProvider.setSortBy(SortBy.ModifiedTime)));
		context.subscriptions.push(vscode.commands.registerCommand('sortedFiles.creationTime', () => this.treeDataProvider.setSortBy(SortBy.CreationTime)));
		context.subscriptions.push(vscode.commands.registerCommand('sortedFiles.fileName', () => this.treeDataProvider.setSortBy(SortBy.FileName)));
		context.subscriptions.push(vscode.commands.registerCommand('sortedFiles.fileSize', () => this.treeDataProvider.setSortBy(SortBy.FileSize)));
	}

	private openFolder() {
		const options: vscode.OpenDialogOptions = {
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: 'Open',
	   };
	   
	   vscode.window.showOpenDialog(options).then(folderUri => {
		   if (folderUri && folderUri[0]) {
			   console.log('Selected file: ' + folderUri[0].fsPath);
			   this.treeDataProvider.updateWatchedFolder(folderUri[0]);
		   }
	   });
	}

	private openResource(resource: vscode.Uri): void {
		vscode.window.showTextDocument(resource);
	}
}