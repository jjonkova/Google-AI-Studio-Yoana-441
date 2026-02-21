/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useCallback } from 'react';
import { 
  Upload, 
  FileText, 
  Download, 
  Trash2, 
  Loader2, 
  CheckCircle2, 
  AlertCircle,
  Table as TableIcon,
  ChevronRight
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI, Type } from "@google/genai";
import { 
  PieChart, 
  Pie, 
  Cell, 
  ResponsiveContainer, 
  Tooltip, 
  Legend,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  LineChart,
  Line,
  AreaChart,
  Area
} from 'recharts';

// --- Types ---

interface Transaction {
  date: string;
  description: string;
  amount: number;
  category: string;
  notes: string;
  // Analytics fields
  duplicateFlag?: boolean;
  anomalyScore?: number;
  isRecurring?: boolean;
}

// --- Constants ---

const CATEGORIES = [
  'groceries', 'dining', 'transport', 'salary', 'bills', 
  'health', 'shopping', 'entertainment', 'other'
];

const CHART_COLORS = [
  '#141414', '#5A5A40', '#F27D26', '#FF4444', '#4A4A4A', 
  '#8E9299', '#D1D1D1', '#5A5A40', '#000000'
];

// --- Components ---

export default function App() {
  const [files, setFiles] = useState<File[]>([]);
  const [isExtracting, setIsExtracting] = useState(false);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string>('');
  const [completedCount, setCompletedCount] = useState(0);
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = e.target.files;
    if (selectedFiles) {
      processFiles(Array.from(selectedFiles));
    }
  };

  const processFiles = (newFiles: File[]) => {
    const validFiles = newFiles.filter(f => f.type === 'application/pdf' || f.type.startsWith('image/'));
    
    if (validFiles.length !== newFiles.length) {
      setError('Some files were skipped. Please upload only PDFs or images.');
    } else {
      setError(null);
    }
    
    if (validFiles.length > 0) {
      setFiles(prev => [...prev, ...validFiles]);
      setTransactions([]);
      setCompletedCount(0);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const droppedFiles = e.dataTransfer.files;
    if (droppedFiles) {
      processFiles(Array.from(droppedFiles));
    }
  };

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
    if (files.length === 1) {
      setTransactions([]);
      setError(null);
      setCompletedCount(0);
    }
  };

  const extractTransactions = async () => {
    if (files.length === 0) return;

    setIsExtracting(true);
    setError(null);
    setTransactions([]);
    setCompletedCount(0);
    
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
    let allTransactions: Transaction[] = [];

    try {
      for (let i = 0; i < files.length; i++) {
        const currentFile = files[i];
        setProgress(`Processing ${currentFile.name}...`);
        
        const base64Data = await fileToBase64(currentFile);
        
        const prompt = `Extract all transactions from this bank statement file. 
        Return a JSON array of objects with the following keys: 
        date (string, format YYYY-MM-DD), 
        description (string), 
        amount (number, negative for expenses/withdrawals, positive for deposits/income), 
        category (string, one of: ${CATEGORIES.join(', ')}), 
        notes (string). 
        
        Rules:
        1. Capture EVERY transaction listed.
        2. Skip headers, footers, summary tables, and non-transaction rows.
        3. If the date format in the document is different, convert it to YYYY-MM-DD.
        4. Ensure amounts are correctly signed based on whether they are debits or credits.
        5. Auto-detect the best category for each transaction.`;

        const response = await ai.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: [
            {
              parts: [
                { text: prompt },
                {
                  inlineData: {
                    mimeType: currentFile.type,
                    data: base64Data
                  }
                }
              ]
            }
          ],
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  date: { type: Type.STRING },
                  description: { type: Type.STRING },
                  amount: { type: Type.NUMBER },
                  category: { type: Type.STRING },
                  notes: { type: Type.STRING }
                },
                required: ['date', 'description', 'amount', 'category', 'notes']
              }
            }
          }
        });

        const resultText = response.text;
        if (resultText) {
          const parsedData = JSON.parse(resultText) as Transaction[];
          allTransactions.push(...parsedData);
          
          // Perform analytics on the current accumulated set
          const analyzed = performAdvancedAnalytics(allTransactions);
          const sorted = analyzed.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
          setTransactions(sorted);
        }
        
        setCompletedCount(i + 1);
      }
      
      setProgress('Batch extraction complete!');
    } catch (err: any) {
      console.error(err);
      setError(`Error processing file ${completedCount + 1}: ${err.message || 'Unknown error'}`);
    } finally {
      setIsExtracting(false);
    }
  };

  const performAdvancedAnalytics = (data: Transaction[]): Transaction[] => {
    if (data.length === 0) return [];

    // 1. Duplicate Detection
    const seen = new Map<string, number>();
    data.forEach(t => {
      const key = `${t.date}-${t.description}-${t.amount}`;
      seen.set(key, (seen.get(key) || 0) + 1);
    });

    // 2. Anomaly Detection (Mean/Std Dev)
    const amounts = data.map(t => Math.abs(t.amount));
    const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const variance = amounts.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / amounts.length;
    const stdDev = Math.sqrt(variance);

    // 3. Recurring Payments Detection
    const descGroups = new Map<string, number[]>();
    data.forEach(t => {
      const normalizedDesc = t.description.toLowerCase().replace(/\d+/g, '').trim();
      if (!descGroups.has(normalizedDesc)) descGroups.set(normalizedDesc, []);
      descGroups.get(normalizedDesc)?.push(Math.abs(t.amount));
    });

    return data.map(t => {
      const key = `${t.date}-${t.description}-${t.amount}`;
      const normalizedDesc = t.description.toLowerCase().replace(/\d+/g, '').trim();
      const amountsInGroup = descGroups.get(normalizedDesc) || [];
      
      // Calculate anomaly score
      const absAmount = Math.abs(t.amount);
      const anomalyScore = stdDev > 0 ? (absAmount - mean) / stdDev : 0;

      return {
        ...t,
        duplicateFlag: (seen.get(key) || 0) > 1,
        anomalyScore: parseFloat(anomalyScore.toFixed(2)),
        isRecurring: amountsInGroup.length >= 2 // Simple heuristic: seen same normalized description twice
      };
    });
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const base64String = (reader.result as string).split(',')[1];
        resolve(base64String);
      };
      reader.onerror = (error) => reject(error);
    });
  };

  const downloadCSV = () => {
    if (transactions.length === 0) return;

    const headers = ['Date', 'Description', 'Amount', 'Category', 'Notes'];
    const csvContent = [
      headers.join(','),
      ...transactions.map(t => [
        t.date,
        `"${t.description.replace(/"/g, '""')}"`,
        t.amount,
        t.category,
        `"${t.notes.replace(/"/g, '""')}"`
      ].join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `bank_statement_batch_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const getChartData = () => {
    const spendingByCategory: Record<string, number> = {};
    
    transactions.forEach(t => {
      if (t.amount < 0) {
        const category = t.category.toLowerCase();
        spendingByCategory[category] = (spendingByCategory[category] || 0) + Math.abs(t.amount);
      }
    });

    return Object.entries(spendingByCategory).map(([name, value]) => ({
      name: name.charAt(0).toUpperCase() + name.slice(1),
      value: parseFloat(value.toFixed(2))
    })).sort((a, b) => b.value - a.value);
  };

  const chartData = getChartData();

  const getAnalyticsSummary = () => {
    if (transactions.length === 0) return null;

    const totalSpending = transactions.filter(t => t.amount < 0).reduce((acc, t) => acc + Math.abs(t.amount), 0);
    const totalIncome = transactions.filter(t => t.amount > 0).reduce((acc, t) => acc + t.amount, 0);
    const duplicates = transactions.filter(t => t.duplicateFlag).length;
    const suspicious = transactions.filter(t => (t.anomalyScore || 0) > 2).length;
    const highest = [...transactions].sort((a, b) => b.amount - a.amount)[0];
    const lowest = [...transactions].sort((a, b) => a.amount - b.amount)[0];

    // Spikes data (group by date)
    const spikesMap = new Map<string, number>();
    transactions.forEach(t => {
      if (t.amount < 0) {
        spikesMap.set(t.date, (spikesMap.get(t.date) || 0) + Math.abs(t.amount));
      }
    });
    const spikesData = Array.from(spikesMap.entries())
      .map(([date, amount]) => ({ date, amount }))
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    // Anomaly data
    const anomalyData = transactions.map((t, i) => ({
      index: i,
      score: t.anomalyScore || 0,
      desc: t.description
    })).filter(d => d.score > 1);

    return {
      totalRecords: transactions.length,
      totalSpending,
      totalIncome,
      duplicates,
      suspicious,
      highest,
      lowest,
      spikesData,
      anomalyData
    };
  };

  const summary = getAnalyticsSummary();

  return (
    <div className="min-h-screen bg-[#F5F5F0] text-[#141414] font-sans p-4 md:p-8">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <header className="mb-12 flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <h1 className="text-5xl font-serif italic tracking-tight mb-2">Statement OCR</h1>
            <p className="text-sm uppercase tracking-widest opacity-60 font-mono">Powered by Gemini 3 Flash</p>
          </div>
          <div className="h-[1px] flex-grow mx-8 bg-[#141414] opacity-10 hidden md:block"></div>
          <div className="text-right">
            <span className="text-xs font-mono opacity-50">v1.2.0</span>
          </div>
        </header>

        <main className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Left Column: Upload & Controls */}
          <div className="lg:col-span-4 space-y-6">
            <div 
              className={`
                relative border-2 border-dashed rounded-2xl p-8 transition-all duration-300
                ${files.length > 0 ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-[#141414]/10 hover:border-[#141414]/30 bg-white'}
                flex flex-col items-center justify-center text-center cursor-pointer min-h-[300px]
              `}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={handleFileChange} 
                className="hidden" 
                accept="application/pdf,image/*"
                multiple
              />

              <AnimatePresence mode="wait">
                {files.length === 0 ? (
                  <motion.div 
                    key="empty"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="space-y-4"
                  >
                    <div className="w-16 h-16 bg-[#141414]/5 rounded-full flex items-center justify-center mx-auto">
                      <Upload className="w-8 h-8 opacity-40" />
                    </div>
                    <div>
                      <p className="font-medium">Drop statements here</p>
                      <p className="text-xs opacity-50 mt-1">PDF or Images (Multiple allowed)</p>
                    </div>
                  </motion.div>
                ) : (
                  <motion.div 
                    key="files-list"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="w-full space-y-3 max-h-[400px] overflow-y-auto pr-2"
                  >
                    {files.map((f, i) => (
                      <div key={i} className={`
                        flex items-center justify-between p-3 rounded-xl border transition-all
                        ${i < completedCount ? 'bg-emerald-50 border-emerald-100' : 'bg-white border-[#141414]/5 shadow-sm'}
                        ${i === completedCount && isExtracting ? 'ring-2 ring-blue-400 border-blue-200' : ''}
                      `}>
                        <div className="flex items-center gap-3 overflow-hidden">
                          <div className={`w-8 h-8 rounded flex items-center justify-center shrink-0 ${i < completedCount ? 'bg-emerald-500/10 text-emerald-600' : 'bg-[#141414]/5'}`}>
                            {i < completedCount ? <CheckCircle2 className="w-4 h-4" /> : <FileText className="w-4 h-4 opacity-40" />}
                          </div>
                          <div className="text-left overflow-hidden">
                            <p className="text-xs font-medium truncate">{f.name}</p>
                            <p className="text-[10px] opacity-40">{(f.size / 1024 / 1024).toFixed(2)} MB</p>
                          </div>
                        </div>
                        {!isExtracting && (
                          <button 
                            onClick={(e) => { e.stopPropagation(); removeFile(i); }}
                            className="p-1.5 hover:bg-red-50 text-red-500 rounded-md transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    ))}
                    <div className="pt-4">
                      <p className="text-[10px] uppercase tracking-widest opacity-40 font-mono">Click to add more files</p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="space-y-3">
              <button
                disabled={files.length === 0 || isExtracting}
                onClick={extractTransactions}
                className={`
                  w-full py-4 rounded-2xl font-medium transition-all flex items-center justify-center gap-2
                  ${files.length === 0 || isExtracting 
                    ? 'bg-[#141414]/5 text-[#141414]/30 cursor-not-allowed' 
                    : 'bg-[#141414] text-white hover:shadow-lg active:scale-[0.98]'}
                `}
              >
                {isExtracting ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span>Processing...</span>
                  </>
                ) : (
                  <>
                    <ChevronRight className="w-5 h-5" />
                    <span>Extract {files.length} File{files.length !== 1 ? 's' : ''}</span>
                  </>
                )}
              </button>

              {transactions.length > 0 && (
                <button
                  onClick={downloadCSV}
                  className="w-full py-4 rounded-2xl border border-[#141414] text-[#141414] font-medium hover:bg-[#141414] hover:text-white transition-all flex items-center justify-center gap-2"
                >
                  <Download className="w-5 h-5" />
                  <span>Download CSV</span>
                </button>
              )}
            </div>

            {isExtracting && (
              <div className="space-y-4">
                <div className="p-4 bg-blue-50 border border-blue-100 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between text-xs font-mono text-blue-600">
                    <span className="uppercase tracking-widest">Progress</span>
                    <span>{completedCount} / {files.length} Files</span>
                  </div>
                  <div className="h-1.5 w-full bg-blue-200 rounded-full overflow-hidden">
                    <motion.div 
                      className="h-full bg-blue-600"
                      initial={{ width: 0 }}
                      animate={{ width: `${(completedCount / files.length) * 100}%` }}
                    />
                  </div>
                  <p className="text-[10px] text-blue-500 italic truncate">{progress}</p>
                </div>
                
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="p-2 bg-white rounded-xl border border-[#141414]/5">
                    <p className="text-[10px] uppercase opacity-40 font-mono">Total</p>
                    <p className="text-lg font-serif italic">{files.length}</p>
                  </div>
                  <div className="p-2 bg-white rounded-xl border border-[#141414]/5">
                    <p className="text-[10px] uppercase opacity-40 font-mono">Done</p>
                    <p className="text-lg font-serif italic text-emerald-600">{completedCount}</p>
                  </div>
                  <div className="p-2 bg-white rounded-xl border border-[#141414]/5">
                    <p className="text-[10px] uppercase opacity-40 font-mono">Left</p>
                    <p className="text-lg font-serif italic text-blue-600">{files.length - completedCount}</p>
                  </div>
                </div>
              </div>
            )}

            {error && (
              <div className="p-4 bg-red-50 border border-red-100 rounded-2xl flex gap-3 text-red-600">
                <AlertCircle className="w-5 h-5 shrink-0" />
                <p className="text-sm">{error}</p>
              </div>
            )}
          </div>

          {/* Right Column: Results Table & Charts */}
          <div className="lg:col-span-8 space-y-8">
            {/* Visual Summary Section */}
            <AnimatePresence>
              {summary && (
                <motion.div 
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="grid grid-cols-1 md:grid-cols-3 gap-4"
                >
                  <div className="bg-white p-6 rounded-3xl border border-[#141414]/5 shadow-sm space-y-1">
                    <p className="text-[10px] uppercase tracking-widest opacity-40 font-mono">Total Records</p>
                    <p className="text-3xl font-serif italic">{summary.totalRecords}</p>
                    <div className="flex gap-4 pt-2 text-[10px] font-mono">
                      <span className="text-emerald-600">+{summary.totalIncome.toLocaleString()} Inc</span>
                      <span className="text-red-500">-{summary.totalSpending.toLocaleString()} Exp</span>
                    </div>
                  </div>
                  
                  <div className="bg-white p-6 rounded-3xl border border-[#141414]/5 shadow-sm space-y-1">
                    <p className="text-[10px] uppercase tracking-widest opacity-40 font-mono">Risk Profile</p>
                    <div className="flex items-baseline gap-2">
                      <p className="text-3xl font-serif italic text-red-500">{summary.suspicious}</p>
                      <span className="text-xs opacity-40">Suspicious</span>
                    </div>
                    <p className="text-[10px] font-mono opacity-60">{summary.duplicates} Potential Duplicates</p>
                  </div>

                  <div className="bg-white p-6 rounded-3xl border border-[#141414]/5 shadow-sm space-y-1">
                    <p className="text-[10px] uppercase tracking-widest opacity-40 font-mono">Extremes</p>
                    <div className="space-y-1">
                      <p className="text-xs font-medium truncate text-emerald-600">Max: ${summary.highest?.amount.toLocaleString()}</p>
                      <p className="text-xs font-medium truncate text-red-500">Min: ${summary.lowest?.amount.toLocaleString()}</p>
                    </div>
                  </div>

                  {/* Spikes & Anomalies Charts */}
                  <div className="md:col-span-3 bg-white p-6 rounded-3xl border border-[#141414]/5 shadow-sm">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                      <div className="space-y-4">
                        <h3 className="text-xs font-mono uppercase tracking-widest opacity-40">Spending Spikes</h3>
                        <div className="h-[200px]">
                          <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={summary.spikesData}>
                              <defs>
                                <linearGradient id="colorSpike" x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="5%" stopColor="#141414" stopOpacity={0.1}/>
                                  <stop offset="95%" stopColor="#141414" stopOpacity={0}/>
                                </linearGradient>
                              </defs>
                              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                              <XAxis dataKey="date" hide />
                              <YAxis hide />
                              <Tooltip 
                                contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }}
                              />
                              <Area type="monotone" dataKey="amount" stroke="#141414" fillOpacity={1} fill="url(#colorSpike)" />
                            </AreaChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                      
                      <div className="space-y-4">
                        <h3 className="text-xs font-mono uppercase tracking-widest opacity-40">Anomaly Distribution</h3>
                        <div className="h-[200px]">
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={summary.anomalyData}>
                              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                              <XAxis dataKey="index" hide />
                              <YAxis hide />
                              <Tooltip 
                                contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }}
                                formatter={(value: number) => [`Score: ${value}`, 'Anomaly']}
                              />
                              <Bar dataKey="score" fill="#FF4444" radius={[4, 4, 0, 0]} />
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Chart Section */}
            <AnimatePresence>
              {transactions.length > 0 && (
                <motion.div 
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-white rounded-3xl border border-[#141414]/5 shadow-sm p-6"
                >
                  <div className="flex items-center gap-3 mb-6">
                    <div className="w-8 h-8 bg-[#141414]/5 rounded-full flex items-center justify-center">
                      <div className="w-4 h-4 rounded-full border-2 border-[#141414]/40 border-t-transparent animate-spin-slow" />
                    </div>
                    <h2 className="font-serif italic text-xl">Spending Analysis</h2>
                  </div>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center">
                    <div className="h-[300px] w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={chartData}
                            cx="50%"
                            cy="50%"
                            innerRadius={60}
                            outerRadius={100}
                            paddingAngle={5}
                            dataKey="value"
                          >
                            {chartData.map((entry, index) => (
                              <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                            ))}
                          </Pie>
                          <Tooltip 
                            contentStyle={{ 
                              borderRadius: '12px', 
                              border: 'none', 
                              boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)',
                              fontFamily: 'Inter, sans-serif'
                            }}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    
                    <div className="space-y-4">
                      <h3 className="text-xs font-mono uppercase tracking-widest opacity-40">Top Categories</h3>
                      <div className="space-y-3">
                        {chartData.slice(0, 5).map((item, i) => (
                          <div key={i} className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }} />
                              <span className="text-sm font-medium">{item.name}</span>
                            </div>
                            <span className="text-sm font-mono">${item.value.toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                      <div className="pt-4 border-t border-[#141414]/5">
                        <div className="flex justify-between items-end">
                          <span className="text-xs font-mono uppercase opacity-40">Total Spending</span>
                          <span className="text-2xl font-serif italic">
                            ${chartData.reduce((acc, curr) => acc + curr.value, 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Results Table */}
            <div className="bg-white rounded-3xl border border-[#141414]/5 shadow-sm overflow-hidden min-h-[500px] flex flex-col">
              <div className="p-6 border-bottom border-[#141414]/5 flex items-center justify-between bg-[#FBFBFA]">
                <div className="flex items-center gap-3">
                  <TableIcon className="w-5 h-5 opacity-40" />
                  <h2 className="font-serif italic text-xl">Extracted Transactions</h2>
                </div>
                {transactions.length > 0 && (
                  <span className="text-xs font-mono bg-[#141414]/5 px-2 py-1 rounded-full opacity-60">
                    {transactions.length} items found
                  </span>
                )}
              </div>

              <div className="flex-grow overflow-auto">
                {transactions.length > 0 ? (
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-[#FBFBFA] border-b border-[#141414]/5">
                        <th className="p-4 text-[10px] uppercase tracking-widest font-mono opacity-40">Date</th>
                        <th className="p-4 text-[10px] uppercase tracking-widest font-mono opacity-40">Description</th>
                        <th className="p-4 text-[10px] uppercase tracking-widest font-mono opacity-40 text-right">Amount</th>
                        <th className="p-4 text-[10px] uppercase tracking-widest font-mono opacity-40">Category</th>
                        <th className="p-4 text-[10px] uppercase tracking-widest font-mono opacity-40">Analytics</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#141414]/5">
                      {transactions.map((t, i) => (
                        <motion.tr 
                          key={i}
                          initial={{ opacity: 0, x: -10 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: i * 0.01 }}
                          className={`hover:bg-[#FBFBFA] transition-colors group ${t.duplicateFlag ? 'bg-orange-50/30' : ''} ${(t.anomalyScore || 0) > 2 ? 'bg-red-50/30' : ''}`}
                        >
                          <td className="p-4 text-sm font-mono whitespace-nowrap">{t.date}</td>
                          <td className="p-4">
                            <div className="text-sm font-medium flex items-center gap-2">
                              {t.description}
                              {t.isRecurring && (
                                <span className="text-[8px] bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded-full uppercase tracking-tighter">Recurring</span>
                              )}
                            </div>
                            {t.notes && <div className="text-[10px] opacity-40 italic mt-0.5">{t.notes}</div>}
                          </td>
                          <td className={`p-4 text-sm font-mono text-right ${t.amount < 0 ? 'text-red-500' : 'text-emerald-600'}`}>
                            {t.amount > 0 ? '+' : ''}{t.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                          <td className="p-4">
                            <span className="text-[10px] uppercase tracking-wider font-semibold px-2 py-1 rounded-full bg-[#141414]/5 opacity-60">
                              {t.category}
                            </span>
                          </td>
                          <td className="p-4">
                            <div className="flex flex-wrap gap-1">
                              {t.duplicateFlag && (
                                <span className="text-[8px] bg-orange-100 text-orange-600 px-1.5 py-0.5 rounded-full uppercase font-bold">Duplicate</span>
                              )}
                              {(t.anomalyScore || 0) > 1 && (
                                <span className={`text-[8px] px-1.5 py-0.5 rounded-full uppercase font-bold ${t.anomalyScore! > 2 ? 'bg-red-100 text-red-600' : 'bg-yellow-100 text-yellow-600'}`}>
                                  Score: {t.anomalyScore}
                                </span>
                              )}
                            </div>
                          </td>
                        </motion.tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-center p-12 opacity-20">
                    <TableIcon className="w-16 h-16 mb-4" />
                    <p className="font-serif italic text-lg">No data to display yet</p>
                    <p className="text-sm mt-2">Upload statements and click extract to begin</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </main>

        {/* Footer */}
        <footer className="mt-16 pt-8 border-t border-[#141414]/5 flex flex-col md:flex-row justify-between items-center gap-4 text-[10px] uppercase tracking-widest opacity-40 font-mono">
          <div>© 2026 Statement OCR Tool</div>
          <div className="flex gap-8">
            <span>Privacy Secure</span>
            <span>Gemini AI Integrated</span>
            <span>Batch Processing</span>
          </div>
        </footer>
      </div>
    </div>
  );
}
