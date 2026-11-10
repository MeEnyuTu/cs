        function executeDecode(morseStr) {
            if (!morseStr || morseStr.trim() === "") return "";
            // 1. 清洗多余空格
            let cleanStr = morseStr.replace(/\s+/g, ' ').trim();
            
            // 2. 包含空格，老老实实按字母切分
            if (cleanStr.includes(' ')) {
                let result = ""; 
                const parts = cleanStr.split(' ');
                for (let part of parts) {
                    if (!part) continue;
                    if (reverseMorse[part]) result += reverseMorse[part];
                    else result += "?"; 
                }
                return result || "[空]";
            }

            // 3. 没有空格：如果整体刚好在字典里（比如 "-----" 对应 0），直接返回
            if (reverseMorse[cleanStr]) return reverseMorse[cleanStr];

            // 4. 没有空格且不在字典里，强制贪心解码，如果有残留说明输入了非法的连串电码
            let result = greedyDecode(cleanStr);
            if (result.endsWith("?")) {
                return result + " (未识别)"; // 告诉用户后面的没解开
            }
            return result;
        }

        function greedyDecode(longPart) {
            let result = ""; let temp = "";
            for (let char of longPart) {
                temp += char;
                if (reverseMorse[temp]) { 
                    result += reverseMorse[temp]; 
                    temp = ""; 
                }
            }
            // 如果 temp 还有残留，说明尾巴是解不开的，加个问号
            return result + (temp ? "?" : "");
        }
